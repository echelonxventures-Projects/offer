/**
 * The rule engine. Conditions are tenant-authored data evaluated on the request
 * path, so the tests care as much about what the engine *refuses* as about what
 * it computes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RuleEvaluator } from "../src/rules/evaluator.ts";
import { ruleOperatorRegistry } from "../src/rules/operators.ts";
import { ruleFunctionRegistry } from "../src/rules/functions.ts";
import { globMatch, equalValues, compareValues } from "../src/rules/compare.ts";
import * as r from "../src/rules/ast.ts";
import type { RuleNode } from "../src/rules/ast.ts";
import { platform, cartContext, TENANT, unwrap } from "./_helpers.ts";

async function setup() {
  const p = platform();
  const context = unwrap(await p.context.resolve(cartContext()));
  const evaluator = new RuleEvaluator({
    temporal: p.temporal,
    spatial: p.spatial,
    economic: p.economic,
    operators: ruleOperatorRegistry(),
    functions: ruleFunctionRegistry(),
  });
  return { p, context, evaluator, run: (node?: RuleNode) => evaluator.evaluate(node, context) };
}

describe("evaluation basics", () => {
  test("an absent condition is satisfied", async () => {
    const { run } = await setup();
    assert.equal(unwrap(run(undefined)).satisfied, true);
  });

  test("logical operators short-circuit and say which child decided", async () => {
    const { run } = await setup();
    const outcome = unwrap(run(r.all(r.always, r.never, r.always)));
    assert.equal(outcome.satisfied, false);
    const top = outcome.trace.find((t) => t.op === "all");
    assert.equal(top?.detail, "child 1 failed");
    // The third child must not have been evaluated.
    assert.equal(outcome.trace.filter((t) => t.op === "always").length, 1);
  });

  test("every evaluated node lands in the trace with its depth", async () => {
    const { run } = await setup();
    const outcome = unwrap(run(r.all(r.any(r.never, r.always))));
    assert.deepEqual(
      outcome.trace.map((t) => `${t.depth}:${t.op}=${t.result}`),
      ["2:never=false", "2:always=true", "1:any=true", "0:all=true"],
    );
  });
});

describe("comparison", () => {
  test("money compares against money exactly", async () => {
    const { run } = await setup();
    assert.equal(unwrap(run(r.gte(r.path("cart.subtotal"), r.money("USD", "100.00")))).satisfied, true);
    assert.equal(unwrap(run(r.gt(r.path("cart.subtotal"), r.money("USD", "100.00")))).satisfied, false);
  });

  test("a meaningless comparison is an error, not a false", async () => {
    const { run } = await setup();
    const result = run(r.gt(r.path("subject.id"), r.money("USD", "1.00")));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "RULE_ERROR");
  });

  test("a missing path resolves to undefined and can carry a default", async () => {
    const { run } = await setup();
    assert.equal(unwrap(run(r.exists(r.path("subject.nope")))).satisfied, false);
    assert.equal(unwrap(run(r.eq(r.path("subject.nope", 7), r.lit(7)))).satisfied, true);
  });

  test("integers and bigints compare across their representations", async () => {
    assert.equal(unwrap(compareValues(5n, 5)), 0);
    assert.equal(equalValues(5n, 5), true);
    assert.equal(equalValues({ a: [1, 2] }, { a: [1, 2] }), true);
    assert.equal(equalValues({ a: [1, 2] }, { a: [2, 1] }), false);
  });
});

describe("domain operators", () => {
  test("spatial.within reads the resolved ancestry", async () => {
    const { run } = await setup();
    assert.equal(unwrap(run(r.withinPlace(["earth.us"]))).satisfied, true);
    assert.equal(unwrap(run(r.withinPlace(["earth.in"]))).satisfied, false);
    assert.equal(unwrap(run({ op: "spatial.within", nodes: ["earth"], exclude: ["earth.us.ny"] })).satisfied, false);
  });

  test("temporal.field reads whatever the context calendar published", async () => {
    const { run } = await setup();
    assert.equal(unwrap(run({ op: "temporal.field", field: "dayOfWeek", in: [6, 7] })).satisfied, true);
    assert.equal(unwrap(run({ op: "temporal.field", field: "dayOfWeek", in: [1] })).satisfied, false);
    // A field the calendar does not publish is false, not an error: a rule
    // written for a Martian calendar simply never fires on a Gregorian one.
    assert.equal(unwrap(run({ op: "temporal.field", field: "sol", in: [1] })).satisfied, false);
  });

  test("subject operators read segments and memberships", async () => {
    const { run } = await setup();
    assert.equal(unwrap(run({ op: "subject.hasSegment", segments: ["member"] })).satisfied, true);
    assert.equal(unwrap(run({ op: "subject.hasSegment", segments: ["member", "vip"], mode: "all" })).satisfied, false);
    assert.equal(unwrap(run({ op: "subject.hasMembership", memberships: ["gold"] })).satisfied, false);
  });
});

describe("rule functions", () => {
  test("cart functions aggregate over the targeted lines", async () => {
    const { run } = await setup();
    assert.equal(unwrap(run(r.eq(r.fn("cart.quantityIn", r.lit(["tools"])), r.lit(2)))).satisfied, true);
    assert.equal(
      unwrap(run(r.eq(r.fn("cart.subtotalOf", r.lit(["toys"])), r.money("USD", "40.00")))).satisfied,
      true,
    );
    assert.equal(unwrap(run(r.eq(r.fn("cart.hasSku", r.lit(["WID*"])), r.lit(true)))).satisfied, true);
  });

  test("counters default to zero rather than failing", async () => {
    const { run } = await setup();
    assert.equal(unwrap(run(r.eq(r.fn("subject.counter", r.lit("never.seen")), r.lit(0)))).satisfied, true);
  });

  test("an unknown function is a rule error", async () => {
    const { run } = await setup();
    const result = run(r.eq(r.fn("acme.nope"), r.lit(1)));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "UNKNOWN_REGISTRY_ENTRY");
  });

  test("wrong arity is caught before the function runs", async () => {
    const { run } = await setup();
    assert.equal(run(r.eq(r.fn("subject.counter"), r.lit(0))).ok, false);
  });
});

describe("safety limits", () => {
  test("depth is bounded", async () => {
    const { evaluator, context } = await setup();
    let node: RuleNode = r.always;
    for (let i = 0; i < 40; i += 1) node = r.all(node);
    const result = evaluator.evaluate(node, context);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /nested deeper/);
  });

  test("the node budget is bounded", async () => {
    const { context } = await setup();
    const tight = new RuleEvaluator(
      {
        temporal: platform().temporal,
        spatial: platform().spatial,
        economic: platform().economic,
        operators: ruleOperatorRegistry(),
        functions: ruleFunctionRegistry(),
      },
      { maxDepth: 32, maxNodes: 5 },
    );
    const wide = r.all(...Array.from({ length: 20 }, () => r.always));
    const result = tight.evaluate(wide, context);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /node budget/);
  });

  test("a malformed node is rejected with its shape named", async () => {
    const { run } = await setup();
    assert.equal(run({ notAnOp: true } as unknown as RuleNode).ok, false);
    assert.equal(run({ op: "does.not.exist" }).ok, false);
  });
});

describe("glob matching", () => {
  test("matches the way a pattern is expected to", async () => {
    const cases: [string, string, boolean][] = [
      ["*", "anything", true],
      ["SKU-*", "SKU-123", true],
      ["SKU-*", "OTHER-123", false],
      ["?-1", "A-1", true],
      ["?-1", "AB-1", false],
      ["*-*-*", "a-b-c", true],
      ["a*b*c", "axxbyyc", true],
      ["a*b*c", "axxbyy", false],
      ["", "", true],
      ["", "x", false],
    ];
    for (const [pattern, value, expected] of cases) {
      assert.equal(globMatch(pattern, value), expected, `${pattern} ~ ${value}`);
    }
  });

  test("stays linear on the input that would blow up a backtracking regex", async () => {
    const pattern = "*".repeat(30) + "b";
    const value = "a".repeat(2000);
    const started = process.hrtime.bigint();
    assert.equal(globMatch(pattern, value), false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(elapsedMs < 250, true, `took ${elapsedMs}ms`);
  });
});
