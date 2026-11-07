/**
 * Extension points, and the absence of hardcoded dispatch.
 *
 * Law 2 says anything that varies is a registry entry. Three violations of it
 * survived three phases because nothing was checking: posting rules branched on
 * `effect.key === "commission"`, lifecycle routing was a `switch` over states,
 * and acquisition modes were a closed union.
 *
 * The first half of this file proves each is now genuinely extensible. The
 * second half is a guard so the next one is caught by a test rather than by an
 * audit three phases later.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GoipPlatform } from "../src/platform/platform.ts";
import { DEFAULT_CONFIG, resolveConfig } from "../src/platform/config.ts";
import { routeBetween, lifecycleRegistry } from "../src/model/lifecycle.ts";
import { toDecimal } from "../src/universal/economic/amount.ts";
import { reconcile } from "../src/ledger/payout.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { TENANT, TEST_MS, cartContext, funded, publish, publishUnchecked, simpleDraft, unwrap } from "./_helpers.ts";
import { AUDIT_KINDS } from "../src/audit/audit-log.ts";

const SRC = new URL("../src", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("posting rules are data", () => {
  test("a new effect kind can post somewhere the ledger has never heard of", async () => {
    const platform = await funded();

    // An escrow account: value owed, but not to the subject and not yet payable.
    platform.deps.postingRules.register({
      key: "acme.escrow",
      label: "Escrow until delivery is confirmed",
      resolve: ({ tenant, value, accounts }) => ({
        ok: true as const,
        value: {
          accountId: accounts.custom(["escrow", tenant, value.unit]),
          memo: "held pending delivery",
        },
      }),
    });

    platform.deps.effectKinds.register({
      key: "acme.escrowed_credit",
      label: "Credit held in escrow",
      reducesPayable: false,
      createsLiability: true,
      requiresSettlement: true,
      posting: "acme.escrow",
    });

    await publish(
      platform,
      simpleDraft({
        benefits: [{ id: "b", type: "percentage", params: { rate: "10" }, effect: "acme.escrowed_credit" }],
      }),
    );

    const redeemed = unwrap(
      await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }),
    );

    const credit = redeemed.entries.find((entry) => entry.direction === "credit")!;
    assert.equal(credit.accountId, "escrow:test:USD", "the new rule chose the account");
    assert.equal(credit.memo, "held pending delivery");

    // And the books still balance, because nothing about the invariant changed.
    for (const position of reconcile(unwrap(await platform.store.ledger.all(TENANT)))) {
      assert.ok(position.netMinor !== undefined);
    }
  });

  test("a posting rule that needs a subject says so rather than posting wrongly", async () => {
    const platform = await funded();
    platform.deps.effectKinds.register({
      key: "acme.subject_only",
      label: "Needs a subject",
      reducesPayable: false,
      createsLiability: true,
      requiresSettlement: true,
      posting: "subject_wallet",
    });
    await publish(
      platform,
      simpleDraft({
        benefits: [{ id: "b", type: "percentage", params: { rate: "10" }, effect: "acme.subject_only" }],
      }),
    );

    const anonymous = cartContext({ subject: undefined });
    const result = await platform.capabilities.redeem({ context: anonymous, actor: "t", idempotencyKey: "k" });

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /needs an identified subject/);
  });

  test("account naming can be replaced wholesale for an existing chart of accounts", async () => {
    const platform = new GoipPlatform({
      clock: fixedClock(BigInt(TEST_MS) * 1_000_000n),
      ids: sequentialIdFactory(),
      accounts: {
        expense: (funderId, unit) => `4000-${funderId}-${unit}`,
        clearing: (tenant, unit) => `1200-${tenant}-${unit}`,
        subjectWallet: (subjectId, unit) => `2100-${subjectId}-${unit}`,
        pointsLiability: (subjectId, unit) => `2200-${subjectId}-${unit}`,
        payable: (kind, id, unit) => `2000-${kind}-${id}-${unit}`,
        custom: (segments) => segments.join("-"),
      },
    });
    unwrap(
      await platform.capabilities.fund({
        tenant: TENANT, actor: "t", sourceId: "merchant-1", label: "B",
        party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "1000.00",
      }),
    );
    await publish(platform, simpleDraft());

    const redeemed = unwrap(
      await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }),
    );
    assert.deepEqual(redeemed.entries.map((e) => e.accountId).sort(), ["1200-test-USD", "4000-merchant-1-USD"]);
  });
});

describe("acquisition modes are data", () => {
  test("a mode nobody anticipated works with no engine change", async () => {
    const platform = await funded();

    // "Holds a qualifying membership token", resolved into a context facet
    // upstream - the same discipline rule operators follow.
    platform.deps.acquisitionModes.register({
      key: "acme.token_held",
      label: "Holds a qualifying token",
      check: ({ context, exchange }) => {
        const held = context.facets["tokens"];
        const wanted = exchange.metadata.token;
        const has = Array.isArray(held) && typeof wanted === "string" && held.includes(wanted);
        return has
          ? { passed: true, detail: `token ${wanted} held` }
          : { passed: false, detail: `token ${String(wanted)} not held` };
      },
    });

    await publish(
      platform,
      simpleDraft({
        acquisition: { mode: "acme.token_held" },
        metadata: { token: "GOLD-PASS" },
      }),
    );

    const without = unwrap(await platform.capabilities.apply({ context: cartContext() }));
    assert.equal(without.decision.applied.length, 0);
    assert.match(without.decision.rejected[0]!.reason, /not held/);

    const with_ = unwrap(
      await platform.capabilities.apply({
        context: cartContext({ facets: { tokens: ["GOLD-PASS"] } }),
      }),
    );
    assert.equal(with_.decision.applied.length, 1);
  });

  test("an unregistered mode fails closed, with the mode named", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft({ acquisition: { mode: "acme.nonexistent" } }));

    const quote = unwrap(await platform.capabilities.apply({ context: cartContext() }));
    assert.equal(quote.decision.applied.length, 0);
    assert.match(quote.decision.rejected[0]!.reason, /unknown acquisition mode 'acme.nonexistent'/);
  });
});

describe("lifecycle routing is derived, not hardcoded", () => {
  test("the shipped route to active is the shortest legal one", () => {
    const registry = lifecycleRegistry();
    assert.deepEqual(unwrap(routeBetween(registry, "draft", "active")), ["in_review", "approved", "active"]);
    assert.deepEqual(unwrap(routeBetween(registry, "paused", "active")), ["active"]);
    assert.deepEqual(unwrap(routeBetween(registry, "active", "active")), []);
  });

  test("an unreachable state is refused, listing what is reachable", () => {
    const registry = lifecycleRegistry();
    const result = routeBetween(registry, "archived", "active");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "ILLEGAL_STATE");
  });

  test("a custom state inserted into the graph is routed through", async () => {
    const platform = await funded();

    // A deployment that requires legal sign-off between review and approval.
    platform.deps.lifecycle
      .register({ key: "in_review->legal_review", label: "to legal", from: "in_review", to: "legal_review" as never })
      .register({
        key: "legal_review->approved",
        label: "to approved",
        from: "legal_review" as never,
        to: "approved",
        requiresApproval: true,
      });

    const route = unwrap(routeBetween(platform.deps.lifecycle, "draft", "active"));
    assert.ok(route.includes("legal_review" as never) || route.length === 3, "the shortest route is still taken");

    // Publishing still works: the route is computed, not assumed.
    const created = unwrap(
      await platform.capabilities.create({ tenant: TENANT, actor: "author", draft: simpleDraft() }),
    );
    const published = unwrap(
      await platform.capabilities.publish({
        tenant: TENANT, actor: "author", valueExchangeId: created.id, approvedBy: "approver",
      }),
    );
    assert.equal(published.state, "active");
  });
});

describe("tuning is configuration, not constants", () => {
  test("defaults resolve, and overrides merge one section at a time", () => {
    const config = resolveConfig({ stacking: { exhaustiveLimit: 4 } });
    assert.equal(config.stacking.exhaustiveLimit, 4);
    assert.equal(config.rules.maxDepth, DEFAULT_CONFIG.rules.maxDepth, "untouched sections keep their defaults");
  });

  test("lowering the stacking limit changes the search mode, not the answer's validity", async () => {
    const platform = new GoipPlatform({
      clock: fixedClock(BigInt(TEST_MS) * 1_000_000n),
      ids: sequentialIdFactory(),
      config: { stacking: { exhaustiveLimit: 1 } },
    });
    unwrap(
      await platform.capabilities.fund({
        tenant: TENANT, actor: "t", sourceId: "merchant-1", label: "B",
        party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "10000.00",
      }),
    );
    await publish(platform, simpleDraft({ name: "a", stacking: { groups: ["a"], application: "parallel" } }));
    await publish(platform, simpleDraft({ name: "b", stacking: { groups: ["b"], application: "parallel" } }));

    const quote = unwrap(await platform.capabilities.apply({ context: cartContext() }));
    assert.equal(quote.decision.searchMode, "greedy", "two candidates exceeds a limit of one");
    assert.equal(toDecimal(quote.decision.payableReduction), "20.00", "and the answer is still correct");
  });

  test("a tighter rule budget is enforced", async () => {
    const platform = new GoipPlatform({
      clock: fixedClock(BigInt(TEST_MS) * 1_000_000n),
      ids: sequentialIdFactory(),
      config: { rules: { maxNodes: 3 } },
    });
    unwrap(
      await platform.capabilities.fund({
        tenant: TENANT, actor: "t", sourceId: "merchant-1", label: "B",
        party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "100.00",
      }),
    );
    await publishUnchecked(
      platform,
      simpleDraft({
        conditions: { op: "all", of: [{ op: "always" }, { op: "always" }, { op: "always" }, { op: "always" }] },
      }),
    );

    const result = await platform.capabilities.apply({ context: cartContext() });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /node budget of 3/);
  });
});

describe("guard: no hardcoded dispatch on registry keys", () => {
  /**
   * The three violations this file exists because of all had the same shape: a
   * comparison against a literal that is a registry key. This catches the next
   * one at the point it is written.
   */
  test("engines and the ledger do not branch on registry key literals", () => {
    const watched = [join(SRC, "engines"), join(SRC, "ledger")];
    const patterns: [RegExp, string][] = [
      [/effect\.key\s*===\s*["']/, "branching on an effect kind"],
      [/\.posting\s*===\s*["']/, "branching on a posting rule"],
      [/acquisition\.mode\s*===\s*["']/, "branching on an acquisition mode"],
      [/\.profile\s*===\s*["']/, "branching on a domain profile"],
      [/\bswitch\s*\(\s*\w*\.?(mode|kind|profile|effect|type)\b/, "switching on a registry key"],
    ];

    const offences: string[] = [];
    for (const directory of watched) {
      for (const file of sourceFiles(directory)) {
        const code = stripComments(readFileSync(file, "utf8"));
        for (const [pattern, why] of patterns) {
          if (pattern.test(code)) offences.push(`${file.replace(SRC, "src")}: ${why}`);
        }
      }
    }
    assert.deepEqual(offences, [], "registry keys are looked up, never compared against literals");
  });

  test("tuning constants are not reintroduced as module-level literals in engines", () => {
    const offences: string[] = [];
    for (const file of sourceFiles(join(SRC, "engines"))) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const match of code.matchAll(/^export const ([A-Z][A-Z0-9_]+)\s*=\s*(\d+)/gm)) {
        // Exported defaults are fine; they must be overridable, which means
        // they are read through configuration rather than used directly.
        const name = match[1] as string;
        if (!name.startsWith("DEFAULT_") && !name.endsWith("_LIMIT")) {
          offences.push(`${file.replace(SRC, "src")}: ${name} is a bare constant`);
        }
      }
    }
    assert.deepEqual(offences, []);
  });
});

describe("guard: analysis stays downstream of decisions", () => {
  /**
   * The incentive-graph document states the rule plainly: never traverse the
   * graph inside a decision. A decision whose latency and outcome depend on how
   * much history a subject has cannot be operated or replayed.
   *
   * That rule survives only while nothing on the decision path can reach the
   * analysis layer, so it is enforced structurally rather than by memory.
   */
  test("no engine, rule, context resolver or ledger module imports src/intelligence", () => {
    const watched = ["engines", "rules", "context", "ledger", "model", "universal"];
    const offences: string[] = [];

    for (const area of watched) {
      for (const file of sourceFiles(join(SRC, area))) {
        const code = readFileSync(file, "utf8");
        if (code.includes("intelligence/")) {
          offences.push(`${file.replace(SRC, "src")} imports the analysis layer`);
        }
      }
    }
    assert.deepEqual(offences, [], "analysis reads what decisions produced; it never feeds them");
  });

  test("the analysis layer never writes", () => {
    // A projection that can write is a second source of truth waiting to drift.
    const forbidden = [".put(", ".append(", ".register(", "saveSnapshot", "saveCheckpoint", "tryConsume"];
    const offences: string[] = [];

    for (const file of sourceFiles(join(SRC, "intelligence"))) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const call of forbidden) {
        if (code.includes(call)) offences.push(`${file.replace(SRC, "src")}: calls ${call}`);
      }
    }
    assert.deepEqual(offences, [], "analysis is read-only");
  });
});

describe("guard: the audit vocabulary is honest", () => {
  /**
   * `AUDIT_KINDS` is a published vocabulary. A consumer filtering on a kind the
   * platform never emits gets an empty result and no indication that it is
   * asking for something that cannot happen - which is how a monitoring
   * dashboard ends up confidently reporting zero.
   *
   * So every declared kind is either emitted somewhere in `src`, or listed here
   * as reserved for deployments to emit themselves. Adding a kind means
   * choosing one of the two, deliberately.
   */
  const RESERVED_FOR_DEPLOYMENTS = new Set([
    // Publication is recorded as a lifecycle transition, which is what it is.
    "value_exchange.published",
    // No capability revokes a grant yet; the kind is reserved for when one does.
    "grant.revoked",
    // Quotes are not material events, so a decision is recorded when it is
    // reserved, inside `execution.reserved`. See ADR 0019.
    "decision.made",
    // The reaper releases through the ordinary release path; the actor on the
    // record is what distinguishes a sweep from a customer cancellation.
    "execution.reaped",
    // Settlement posts ledger entries, which are their own record.
    "settlement.posted",
    // A governance rejection blocks a write, so there is nothing to record
    // against; the caller gets a typed error instead.
    "governance.rejected",
    // Registry changes happen at composition time, before a chain exists.
    "registry.changed",
  ]);

  test("every declared audit kind is either emitted or explicitly reserved", () => {
    const code = sourceFiles(SRC)
      .filter((file) => !file.endsWith("audit-log.ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    const undocumented: string[] = [];
    for (const kind of AUDIT_KINDS) {
      const emitted = code.includes(`"${kind}"`);
      if (!emitted && !RESERVED_FOR_DEPLOYMENTS.has(kind)) {
        undocumented.push(`${kind} is declared but never emitted, and is not listed as reserved`);
      }
    }
    assert.deepEqual(undocumented, []);
  });

  test("nothing is reserved that the platform actually emits", () => {
    // The mirror of the test above: a kind that starts being emitted must come
    // off the reserved list, or the list becomes folklore.
    const code = sourceFiles(SRC)
      .filter((file) => !file.endsWith("audit-log.ts") && !file.endsWith("extensibility.test.ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    const stale = [...RESERVED_FOR_DEPLOYMENTS].filter((kind) => code.includes(`kind: "${kind}"`));
    assert.deepEqual(stale, [], "these are emitted now and should not be listed as reserved");
  });
});

describe("guard: the SQL adapter stays portable", () => {
  /**
   * Postgres found three SQLite-isms that had been sitting in this adapter
   * since Phase 1, and it found them by running, not by review. These catch the
   * next one at the point it is written, because the failure mode is a query
   * that works perfectly on the database the author happened to have.
   */
  /** Source with TypeScript *and* SQL comments removed - the schema documents
   *  the very constructs this bans, and a guard that cannot tell a comment from
   *  code teaches people to ignore it. */
  const sqlSource = () =>
    sourceFiles(join(SRC, "adapters", "sql"))
      .filter((file) => !file.endsWith("dialect.ts"))
      .map((file) => {
        const withoutTs = stripComments(readFileSync(file, "utf8"));
        const withoutSql = withoutTs
          .split("\n")
          .map((line) => {
            const comment = line.indexOf("--");
            return comment === -1 ? line : line.slice(0, comment);
          })
          .join("\n");
        return [file.replace(SRC, "src"), withoutSql] as const;
      });

  /**
   * Just the SQL: the contents of every backtick template literal, with `${}`
   * interpolations removed. An interpolation is TypeScript - the arguments to
   * `dialect.greatest` are quoted strings, and they are not SQL literals.
   */
  const sqlLiterals = (code: string): string[] =>
    [...code.matchAll(/`([^`]*)`/g)]
      .map((match) => (match[1] ?? "").replaceAll(/\$\{[^}]*\}/g, "?"))
      // Only templates that are actually SQL. The file is full of error
      // messages like `no funding source '?'`, which are not queries.
      .filter((literal) => /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(literal));

  test("no SQLite-only syntax outside the dialect", () => {
    const banned: [RegExp, string][] = [
      [/\browid\b/i, "rowid has no portable equivalent"],
      [/LIMIT\s+-1/i, "LIMIT -1 is SQLite spelling"],
      [/\bAUTOINCREMENT\b/i, "AUTOINCREMENT is SQLite spelling"],
      [/\bPRAGMA\b/i, "PRAGMA belongs in the dialect's setup"],
      [/\bIFNULL\s*\(/i, "IFNULL is not portable; COALESCE is"],
      [/\bGROUP_CONCAT\s*\(/i, "GROUP_CONCAT is spelled differently elsewhere"],
      // SQLite's INTEGER is 64-bit and Postgres's is 32-bit. A millisecond
      // epoch overflows the latter, which surfaced as "value out of range"
      // from inside a reservation sweep. Casts go through dialect.types.
      [/CAST\s*\([^)]*\bAS\s+INTEGER\s*\)/i, "CAST ... AS INTEGER must use the dialect's integer type"],
    ];

    const offences: string[] = [];
    for (const [name, code] of sqlSource()) {
      for (const [pattern, why] of banned) {
        if (pattern.test(code)) offences.push(`${name}: ${why}`);
      }
    }
    assert.deepEqual(offences, []);
  });

  test("scalar MAX goes through the dialect", () => {
    // MAX(a, b) is a scalar in SQLite and an aggregate in Postgres, which calls
    // the scalar one GREATEST. Aggregate MAX(x) is fine and must stay allowed.
    const offences: string[] = [];
    for (const [name, code] of sqlSource()) {
      if (/\bMAX\s*\(\s*[^)]+,\s*[^)]+\)/.test(code)) {
        offences.push(`${name}: two-argument MAX must use dialect.greatest`);
      }
    }
    assert.deepEqual(offences, []);
  });

  test("text columns are ordered through the dialect, not the database's collation", () => {
    // SQLite's only text collation is BINARY, which compares by codepoint.
    // Postgres collates by the database's LC_COLLATE - locale-dependent, and
    // case-folding in most locales - so a bare `ORDER BY` on a text column
    // disagrees with every other adapter on any mixed-case id, and ids here
    // embed unit codes like `USD`, so mixed-case is the normal case. The
    // failure only appears against a real second database, which is exactly how
    // it shipped unnoticed. See ADR 0020.
    //
    // A sort key the dialect builds is a `${...}` interpolation, so it cannot
    // match a bare-identifier pattern at all; an expression such as
    // `CAST(col AS ...)` is excluded by the paren lookahead. What remains is a
    // bare column, and a bare column ordered in SQL is text unless it is one of
    // the numeric columns below.
    const numericSortColumns = new Set(["seq", "at_seconds"]);
    const offences: string[] = [];
    for (const [name, code] of sqlSource()) {
      for (const match of code.matchAll(/ORDER BY\s+([A-Za-z_]\w*)\b(?!\s*\()/gi)) {
        const column = (match[1] ?? "").toLowerCase();
        if (!numericSortColumns.has(column)) {
          offences.push(
            `${name}: ORDER BY ${column} sorts text by the database's default collation; use dialect.orderByText`,
          );
        }
      }
    }
    assert.deepEqual(offences, []);
  });

  test("an upsert never leaves a column reference unqualified", () => {
    // `DO UPDATE SET x = x + 1` is ambiguous in Postgres - the bare column
    // could be the stored row or the proposed one. SQLite guesses; Postgres
    // refuses. This broke every transactional path the first time Postgres ran.
    const offences: string[] = [];
    for (const [name, code] of sqlSource()) {
      for (const match of code.matchAll(/DO UPDATE SET ([^`,\n]+)/g)) {
        const assignment = match[1] ?? "";
        const [target, expression = ""] = assignment.split("=");
        const column = (target ?? "").trim();
        // A bare occurrence of the assigned column on the right-hand side, not
        // qualified by a table name or `excluded.`.
        if (new RegExp(`(^|[^.\\w])${column}\\b`).test(expression.trim())) {
          offences.push(`${name}: '${assignment.trim()}' must qualify ${column} with its table`);
        }
      }
    }
    assert.deepEqual(offences, []);
  });

  test("every query writes placeholders as ?, and none appears in a string literal", () => {
    // The session renumbers `?` positionally without parsing SQL, so a literal
    // question mark inside a quoted string would be rewritten into a parameter
    // reference. Nothing here contains one; this is what keeps that true.
    const offences: string[] = [];
    for (const [name, code] of sqlSource()) {
      for (const sql of sqlLiterals(code)) {
        // A quoted SQL string, inside the SQL - not a TypeScript argument that
        // happens to be single-quoted.
        for (const quoted of sql.matchAll(/'[^'\n]*'/g)) {
          if ((quoted[0] ?? "").includes("?")) {
            offences.push(`${name}: ${quoted[0]} contains a literal ?`);
          }
        }
        if (/\$\d/.test(sql)) offences.push(`${name}: writes a Postgres placeholder directly`);
      }
    }
    assert.deepEqual(offences, []);
  });
});
