/**
 * The architectural claims, tested rather than asserted.
 *
 * Each test here corresponds to a promise made in docs/00-mission/02-constitution.md.
 * If one of these breaks, a constitutional law has been broken and the fix is
 * not to change the test.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { toDecimal } from "../src/universal/economic/amount.ts";
import { CAPABILITIES } from "../src/capabilities/descriptors.ts";
import { DEFAULT_PROFILES } from "../src/profiles/index.ts";
import { Registry } from "../src/registry/registry.ts";
import type { RuleOperator } from "../src/rules/types.ts";
import { ok } from "../src/kernel/result.ts";
import { TENANT, cartContext, funded, platform, publish, simpleDraft, unwrap } from "./_helpers.ts";

const SRC = new URL("../src", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("law: the engines know nothing about domains", () => {
  test("no engine mentions a domain word outside a comment", async () => {
    const banned = ["coupon", "cashback", "giftcard", "gift card", "voucher", "affiliate", "subsidy"];
    const engineFiles = sourceFiles(join(SRC, "engines"));
    assert.ok(engineFiles.length >= 8, "expected the engine directory to be populated");

    const offences: string[] = [];
    for (const file of engineFiles) {
      const code = stripComments(readFileSync(file, "utf8")).toLowerCase();
      for (const word of banned) {
        if (code.includes(word)) offences.push(`${file.replace(SRC, "src")}: ${word}`);
      }
    }
    assert.deepEqual(offences, [], "engines must not branch on domain vocabulary");
  });

  test("the kernel knows nothing about money, time or place either", async () => {
    const banned = ["usd", "gregorian", "country", "latitude", "timezone"];
    for (const file of sourceFiles(join(SRC, "kernel"))) {
      const code = stripComments(readFileSync(file, "utf8")).toLowerCase();
      for (const word of banned) {
        assert.equal(code.includes(word), false, `${file.replace(SRC, "src")} mentions '${word}'`);
      }
    }
  });
});

describe("law: extension is registration, never a code change", () => {
  test("a brand-new benefit type works with no change to any engine", async () => {
    const p = await funded();

    // A benefit nobody anticipated: a flat rebate per whole unit of spend,
    // denominated in carbon credits. Registered at runtime, as data.
    p.deps.benefitTypes.register({
      key: "acme.carbon_rebate",
      label: "Carbon rebate",
      params: ["gramsPerUnit"],
      unitPolicy: "declared",
      compute(input) {
        const grams = Number(input.spec.params.gramsPerUnit ?? 0);
        const wholeUnits = input.base.minor / 10n ** BigInt(input.base.scale);
        return {
          ok: true,
          value: {
            benefitId: input.spec.id,
            type: input.spec.type,
            effect: input.spec.effect,
            value: { unit: input.unit, scale: input.scale, minor: wholeUnits * BigInt(grams) },
            allocations: [],
            detail: `${grams}g per unit of ${input.base.unit}`,
          },
        };
      },
    });

    await publish(
      p,
      simpleDraft({
        name: "Carbon rebate",
        benefits: [
          {
            id: "carbon",
            type: "acme.carbon_rebate",
            params: { gramsPerUnit: 5 },
            effect: "points_grant",
            unit: "CARBON_KG",
          },
        ],
      }),
    );

    const quote = unwrap(await p.capabilities.apply({ context: cartContext() }));
    assert.equal(quote.decision.applied.length, 1);
    assert.equal(quote.decision.granted[0]!.unit, "CARBON_KG");
    assert.equal(quote.decision.granted[0]!.minor, 500n, "100 whole USD at 5g each");
  });

  test("a brand-new rule operator works the same way", async () => {
    const p = await funded();
    const luckyOperator: RuleOperator = {
      key: "acme.isLucky",
      label: "Lucky subject",
      args: ["digit"],
      evaluate(node, ctx) {
        const id = ctx.context.subject.id ?? "";
        return ok({ result: id.endsWith(String(node.digit)), detail: `subject ${id}` });
      },
    };
    (p.registries["rule-operator"] as unknown as Registry<RuleOperator>).register(luckyOperator);

    await publish(p, simpleDraft({ conditions: { op: "acme.isLucky", digit: 1 } }));
    assert.equal(unwrap(await p.capabilities.apply({ context: cartContext() })).decision.applied.length, 1);

    const unlucky = cartContext({ subject: { id: "s9", segments: [], counters: {} } });
    assert.equal(unwrap(await p.capabilities.apply({ context: unlucky })).decision.applied.length, 0);
  });

  test("a brand-new economic unit and calendar need no code", async () => {
    const p = await funded();
    p.economic.units.register({ key: "KRYPTON", label: "Krypton standard", scale: 5, unitClass: "fiat", fungible: true });
    assert.equal(toDecimal(unwrap(p.economic.parse("KRYPTON", "1.50000"))), "1.50000");
    assert.equal(p.temporal.calendars.has("mars.msd"), true);
  });
});

describe("law: every registry is enumerable and self-describing", () => {
  test("the platform can inventory its own extension surface", async () => {
    const description = platform().describe();
    assert.ok(description.registries.length >= 20, "expected at least twenty registries");
    assert.ok(description.totalEntries > 100);
    for (const registry of description.registries) {
      assert.equal(registry.keys.length, registry.entries, `${registry.name} miscounts its entries`);
    }
  });

  test("describe() output is stable and sorted", async () => {
    const names = platform().describe().registries.map((r) => r.name);
    assert.deepEqual(names, [...names].sort());
  });

  test("a sealed registry refuses further registration", async () => {
    const registry = new Registry<{ key: string; label: string }>("test").register({ key: "a", label: "A" });
    registry.seal();
    assert.throws(() => registry.register({ key: "b", label: "B" }), /sealed/);
  });

  test("a duplicate key is refused in strict mode and allowed by override", async () => {
    const registry = new Registry<{ key: string; label: string }>("test").register({ key: "a", label: "A" });
    assert.throws(() => registry.register({ key: "a", label: "again" }), /already has key/);
    registry.override({ key: "a", label: "replaced" });
    assert.equal(registry.get("a")!.label, "replaced");
  });

  test("a fork inherits entries and may shadow them without touching the parent", async () => {
    const parent = new Registry<{ key: string; label: string }>("p").register({ key: "a", label: "A" });
    const child = parent.fork("c").override({ key: "a", label: "tenant override" });
    assert.equal(parent.get("a")!.label, "A");
    assert.equal(child.get("a")!.label, "tenant override");
  });

  test("a missing entry names the registry and what is available", async () => {
    const registry = new Registry<{ key: string; label: string }>("thing").register({ key: "a", label: "A" });
    const result = registry.require("b");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /registry 'thing'/);
    assert.deepEqual(result.ok === false ? result.error.details!.available : [], ["a"]);
  });
});

describe("law: the capability layer is the whole surface", () => {
  test("all twenty-two specified capabilities exist", async () => {
    assert.equal(CAPABILITIES.length, 22);
    const methods = platform().capabilities;
    for (const capability of CAPABILITIES) {
      assert.equal(
        typeof (methods as unknown as Record<string, unknown>)[capability.key],
        "function",
        `capability '${capability.key}' has a descriptor but no method`,
      );
    }
  });

  test("capability keys are unique and each is classified", async () => {
    const keys = CAPABILITIES.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const capability of CAPABILITIES) {
      assert.ok(capability.phase);
      assert.equal(typeof capability.mutating, "boolean");
      assert.equal(typeof capability.financial, "boolean");
    }
  });

  test("the financial capabilities are exactly the ones that move value", async () => {
    const financial = CAPABILITIES.filter((c) => c.financial).map((c) => c.key).sort();
    assert.deepEqual(financial, ["fund", "pay", "redeem", "reserve", "settle"]);
  });
});

describe("law: profiles are labels, not subtypes", () => {
  test("every profile maps to numbered specification domains", async () => {
    const covered = new Set<number>();
    for (const profile of DEFAULT_PROFILES) {
      assert.ok(profile.specDomains?.length, `${profile.key} claims no domains`);
      for (const domain of profile.specDomains ?? []) covered.add(domain);
    }
    // Domains 1-25 are kinds of offer; the rest are platform capabilities.
    for (let domain = 1; domain <= 25; domain += 1) {
      assert.equal(covered.has(domain), true, `specification domain ${domain} has no profile`);
    }
  });

  test("two different profiles produce structurally identical records", async () => {
    const p = await funded();
    const a = await publish(p, simpleDraft({ profile: "coupon", name: "a" }));
    const b = await publish(p, simpleDraft({ profile: "government_benefit", name: "b" }));
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  });

  test("an unregistered profile is refused at creation", async () => {
    const p = await funded();
    const result = await p.capabilities.create({ tenant: TENANT, actor: "a", draft: simpleDraft({ profile: "invented" }) });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "UNKNOWN_REGISTRY_ENTRY");
  });
});

describe("law: context is frozen once resolved", () => {
  test("a resolved context cannot be mutated by an engine", async () => {
    const p = await funded();
    const context = unwrap(await p.context.resolve(cartContext()));
    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.subject), true);
    assert.equal(Object.isFrozen(context.cart!.lines), true);
    assert.throws(() => {
      (context as { reality: string }).reality = "tampered";
    }, TypeError);
  });

  test("resolution records every resolver it ran, including the skips", async () => {
    const p = await funded();
    const context = unwrap(await p.context.resolve(cartContext({ place: undefined })));
    const spatial = context.trace.find((t) => t.resolver === "core.spatial");
    assert.equal(spatial?.outcome, "skipped");
    assert.equal(context.trace.length, await p.context.resolvers.size);
  });

  test("a context with no economic unit is refused rather than guessed", async () => {
    const p = await funded();
    const result = await p.context.resolve({ tenant: TENANT });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /economic unit/);
  });
});

/** Remove block and line comments so prose about coupons is not a violation. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
