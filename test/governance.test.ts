import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canTransition, lifecycleRegistry } from "../src/model/lifecycle.ts";
import { TENANT, cartContext, funded, simpleDraft, unwrap } from "./_helpers.ts";

describe("lifecycle", () => {
  const registry = lifecycleRegistry();

  test("permits the declared transitions and refuses the rest", async () => {
    assert.equal(canTransition(registry, "draft", "in_review").ok, true);
    assert.equal(canTransition(registry, "active", "paused").ok, true);
    assert.equal(canTransition(registry, "draft", "active").ok, false);
    assert.equal(canTransition(registry, "archived", "active").ok, false);
  });

  test("a refusal lists what was allowed instead", async () => {
    const result = canTransition(registry, "draft", "active");
    assert.equal(result.ok, false);
    // Registry order is alphabetical by transition key, which keeps the error
    // message stable across runs.
    const allowed = (result.ok === false ? result.error.details!.allowed : []) as string[];
    assert.deepEqual([...allowed].sort(), ["archived", "in_review"]);
  });
});

describe("policies", () => {
  test("an exchange with no funding cannot be published", async () => {
    const p = await funded();
    const created = unwrap(
      await p.capabilities.create({ tenant: TENANT, actor: "a", draft: simpleDraft({ funding: { model: "single", splits: [] } }) }),
    );
    const report = unwrap(await p.capabilities.validate({ tenant: TENANT, valueExchangeId: created.id }));
    assert.equal(report.passed, false);
    assert.ok(report.violations.some((v) => v.policy === "funding.declared" && v.severity === "error"));

    const published = await p.capabilities.publish({ tenant: TENANT, actor: "a", valueExchangeId: created.id, approvedBy: "b" });
    assert.equal(published.ok, false);
    assert.equal(published.ok === false && published.error.code, "GOVERNANCE_REJECTED");
  });

  test("a funding source that does not exist is an error", async () => {
    const p = await funded();
    const created = unwrap(
      await p.capabilities.create({
        tenant: TENANT, actor: "a",
        draft: simpleDraft({ funding: { model: "single", splits: [{ sourceId: "ghost" }] } }),
      }),
    );
    const report = unwrap(await p.capabilities.validate({ tenant: TENANT, valueExchangeId: created.id }));
    assert.ok(report.violations.some((v) => v.policy === "funding.sources_exist"));
  });

  test("warnings are reported but do not block", async () => {
    const p = await funded();
    const created = unwrap(
      await p.capabilities.create({ tenant: TENANT, actor: "a", draft: simpleDraft({ governance: {} }) }),
    );
    const report = unwrap(await p.capabilities.validate({ tenant: TENANT, valueExchangeId: created.id }));
    const warnings = report.violations.filter((v) => v.severity === "warning").map((v) => v.policy);
    assert.ok(warnings.includes("owner.named"));
    assert.equal(report.passed, true, "warnings must not block publication");
    assert.equal((await p.capabilities.publish({ tenant: TENANT, actor: "a", valueExchangeId: created.id, approvedBy: "b" })).ok, true);
  });

  test("unbounded exposure is warned about, and a capped funder satisfies it", async () => {
    const p = await funded();
    // merchant-1 has a capped budget, so exposure is bounded by it.
    const bounded = unwrap(await p.capabilities.create({ tenant: TENANT, actor: "a", draft: simpleDraft() }));
    const boundedReport = unwrap(await p.capabilities.validate({ tenant: TENANT, valueExchangeId: bounded.id }));
    assert.equal(boundedReport.violations.some((v) => v.policy === "budget.bounded"), false);

    // An uncapped funder with no limits on the exchange is unbounded exposure.
    unwrap(
      await p.capabilities.fund({
        tenant: TENANT, actor: "a", sourceId: "unlimited", label: "Uncapped",
        party: { kind: "platform", id: "self" }, unit: "USD",
      }),
    );
    const unbounded = unwrap(
      await p.capabilities.create({
        tenant: TENANT, actor: "a",
        draft: simpleDraft({ funding: { model: "single", splits: [{ sourceId: "unlimited" }] } }),
      }),
    );
    const report = unwrap(await p.capabilities.validate({ tenant: TENANT, valueExchangeId: unbounded.id }));
    assert.ok(report.violations.some((v) => v.policy === "budget.bounded" && v.severity === "warning"));
    assert.equal(report.passed, true, "it is a warning, not a block");
  });

  test("a commission in a non-transferable unit is refused", async () => {
    const p = await funded();
    const created = unwrap(
      await p.capabilities.create({
        tenant: TENANT, actor: "a",
        draft: simpleDraft({
          benefits: [{ id: "c", type: "flat", params: { amount: "100" }, effect: "commission", unit: "POINTS" }],
        }),
      }),
    );
    const report = unwrap(await p.capabilities.validate({ tenant: TENANT, valueExchangeId: created.id }));
    assert.ok(report.violations.some((v) => v.policy === "commission.payable_unit" && v.severity === "error"));
  });

  test("a window naming a field its calendar does not publish is refused", async () => {
    const p = await funded();
    const created = unwrap(
      await p.capabilities.create({
        tenant: TENANT, actor: "a",
        draft: simpleDraft({ window: { calendar: "gregorian", constraints: [{ field: "sol", in: [1] }] } }),
      }),
    );
    const report = unwrap(await p.capabilities.validate({ tenant: TENANT, valueExchangeId: created.id }));
    assert.ok(report.violations.some((v) => v.policy === "window.valid"));
  });
});

describe("approval", () => {
  test("an author cannot approve their own exchange", async () => {
    const p = await funded();
    const created = unwrap(await p.capabilities.create({ tenant: TENANT, actor: "author", draft: simpleDraft() }));
    const selfApproved = await p.capabilities.publish({
      tenant: TENANT, actor: "author", valueExchangeId: created.id, approvedBy: "author",
    });
    assert.equal(selfApproved.ok, false);
    assert.match(selfApproved.ok === false ? selfApproved.error.message : "", /other than the author/);
  });

  test("publishing with no approval at all is refused", async () => {
    const p = await funded();
    const created = unwrap(await p.capabilities.create({ tenant: TENANT, actor: "author", draft: simpleDraft() }));
    assert.equal((await p.capabilities.publish({ tenant: TENANT, actor: "author", valueExchangeId: created.id })).ok, false);
  });

  test("a second approver unblocks it", async () => {
    const p = await funded();
    const created = unwrap(await p.capabilities.create({ tenant: TENANT, actor: "author", draft: simpleDraft() }));
    const published = unwrap(
      await p.capabilities.publish({ tenant: TENANT, actor: "author", valueExchangeId: created.id, approvedBy: "reviewer" }),
    );
    assert.equal(published.state, "active");
  });
});

describe("pause and resume", () => {
  test("a paused exchange stops applying and resumes cleanly", async () => {
    const p = await funded();
    const created = unwrap(await p.capabilities.create({ tenant: TENANT, actor: "author", draft: simpleDraft() }));
    unwrap(await p.capabilities.publish({ tenant: TENANT, actor: "author", valueExchangeId: created.id, approvedBy: "r" }));
    assert.equal(unwrap(await p.capabilities.apply({ context: cartContext() })).decision.applied.length, 1);

    unwrap(await p.capabilities.govern({ tenant: TENANT, actor: "ops", valueExchangeId: created.id, to: "paused" }));
    assert.equal(unwrap(await p.capabilities.apply({ context: cartContext() })).decision.applied.length, 0);

    unwrap(await p.capabilities.govern({ tenant: TENANT, actor: "ops", valueExchangeId: created.id, to: "active" }));
    assert.equal(unwrap(await p.capabilities.apply({ context: cartContext() })).decision.applied.length, 1);
  });
});

describe("clone", () => {
  test("a clone starts in draft with no inherited approvals", async () => {
    const p = await funded();
    const created = unwrap(await p.capabilities.create({ tenant: TENANT, actor: "author", draft: simpleDraft() }));
    unwrap(await p.capabilities.publish({ tenant: TENANT, actor: "author", valueExchangeId: created.id, approvedBy: "r" }));

    const copy = unwrap(await p.capabilities.clone({ tenant: TENANT, actor: "author", valueExchangeId: created.id }));
    assert.equal(copy.state, "draft");
    assert.deepEqual(copy.governance.approvals, []);
    assert.notEqual(copy.id, created.id);
    assert.equal(copy.name, "Test 10% off (copy)");
  });
});
