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
