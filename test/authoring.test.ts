/**
 * Authoring: preview, explanations and behavioural diff.
 *
 * The test that matters most is the first one. `RULE_ERROR` in production means
 * an offer silently delivers nothing, and it was previously unpreventable:
 * `validate` checked policy but not semantics, so a broken condition passed
 * review and failed at runtime where nobody was looking.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toDecimal } from "../src/universal/economic/amount.ts";
import { contextSampleRegistry } from "../src/authoring/samples.ts";
import { inferUnit, largestBenefit } from "../src/authoring/preview.ts";
import { diffValueExchange } from "../src/authoring/diff.ts";
import {
  explainDecision,
  explainOffer,
  explainPreview,
  renderExplanation,
} from "../src/authoring/explain.ts";
import { createValueExchange } from "../src/platform/factory.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { TENANT, cartContext, funded, publish, publishUnchecked, simpleDraft, unwrap } from "./_helpers.ts";

/**
 * A genuinely broken condition: `subject.id` is present and a string, compared
 * against a number.
 *
 * Note what is *not* broken any more - `subject.tier` is simply absent in most
 * contexts, and an absent operand is false rather than an error. The
 * distinction is the point: a missing path is a runtime state, a type mismatch
 * is an authoring bug.
 */
const brokenCondition = { op: "gte", left: { path: "subject.id" }, right: { literal: 5 } };

describe("preview closes the RULE_ERROR gap", () => {
  test("an unevaluable condition is refused at publish, not discovered in production", async () => {
    const platform = await funded();
    const created = unwrap(
      await platform.capabilities.create({
        tenant: TENANT,
        actor: "author",
        draft: simpleDraft({ conditions: brokenCondition }),
      }),
    );

    const published = await platform.capabilities.publish({
      tenant: TENANT,
      actor: "author",
      valueExchangeId: created.id,
      approvedBy: "approver",
    });

    assert.equal(published.ok, false, "a broken condition must not reach production");
    assert.equal(published.ok === false && published.error.code, "GOVERNANCE_REJECTED");

    const violations = (published.ok === false ? published.error.details?.violations : []) as {
      policy: string;
      message: string;
    }[];
    assert.ok(violations.some((violation) => violation.policy === "rules.evaluable"));
    assert.match(violations[0]!.message, /would fail at runtime and deliver nothing/);
  });

  test("a draft can be checked before it is ever saved", async () => {
    const platform = await funded();

    const result = unwrap(
      await platform.capabilities.validate({
        tenant: TENANT,
        draft: simpleDraft({ conditions: brokenCondition }),
      }),
    );

    assert.equal(result.preview!.passed, false);
    assert.ok(result.preview!.findings.some((finding) => finding.code === "rule.unevaluable"));

    // Nothing was written: validating a draft must not create anything.
    assert.equal(unwrap(await platform.store.exchanges.find(TENANT)).length, 0);
  });

  test("a sound offer previews cleanly and reports its coverage", async () => {
    const platform = await funded();
    const result = unwrap(
      await platform.capabilities.validate({ tenant: TENANT, draft: simpleDraft() }),
    );

    assert.equal(result.report.passed, true);
    assert.equal(result.preview!.passed, true);
    assert.ok(result.preview!.appliesTo > 0, "a 10% off offer should apply somewhere");
    assert.equal(result.preview!.samplesRun, contextSampleRegistry().size);
  });

  test("preview can be skipped when only policy matters", async () => {
    const platform = await funded();
    const result = unwrap(
      await platform.capabilities.validate({ tenant: TENANT, draft: simpleDraft(), preview: false }),
    );
    assert.equal(result.preview, undefined);
  });
});

describe("preview findings", () => {
  async function previewDraft(draft = simpleDraft()) {
    const platform = await funded();
    const result = unwrap(await platform.capabilities.validate({ tenant: TENANT, draft }));
    return result.preview!;
  }

  test("an offer that applies nowhere is flagged", async () => {
    const report = await previewDraft(
      simpleDraft({ limits: { minimumBase: { unit: "USD", decimal: "999999.00" } } }),
    );
    assert.equal(report.appliesTo, 0);
    assert.ok(report.findings.some((finding) => finding.code === "coverage.none"));
  });

  test("an uncapped percentage is flagged against a large basket", async () => {
    const report = await previewDraft(
      simpleDraft({ benefits: [{ id: "d", type: "percentage", params: { rate: "50" }, effect: "price_reduction" }] }),
    );
    const uncapped = report.findings.find((finding) => finding.code === "benefit.uncapped");
    assert.ok(uncapped, "50% with no cap on a 5,000 basket should be surfaced");
    assert.match(uncapped!.message, /no cap/);
  });

  test("a cap silences that finding", async () => {
    const report = await previewDraft(
      simpleDraft({
        benefits: [
          { id: "d", type: "percentage", params: { rate: "50" }, effect: "price_reduction", cap: { decimal: "10.00" } },
        ],
      }),
    );
    assert.equal(report.findings.some((finding) => finding.code === "benefit.uncapped"), false);
  });

  test("an offer that qualifies but grants nothing is flagged", async () => {
    const report = await previewDraft(
      simpleDraft({
        benefits: [
          { id: "d", type: "tiered", params: { tiers: [{ min: "999999.00", rate: "10" }] }, effect: "price_reduction" },
        ],
      }),
    );
    assert.ok(report.findings.some((finding) => finding.code === "benefit.zero"));
  });

  test("needing a subject or a basket is reported as information, not a problem", async () => {
    const report = await previewDraft(
      simpleDraft({ acquisition: { mode: "issued" } }),
    );
    const subject = report.findings.find((finding) => finding.code === "requires.subject");
    assert.ok(subject === undefined || subject.severity === "info");
  });

  test("samples are re-denominated into the offer's unit", async () => {
    // The shipped samples are USD. An INR offer previously failed preview for
    // the wrong reason: the condition was fine, the sample simply did not match.
    const platform = await funded();
    const draft = simpleDraft({
      conditions: { op: "gte", left: { path: "cart.subtotal" }, right: { amount: { unit: "INR", decimal: "50.00" } } },
      limits: { minimumBase: { unit: "INR", decimal: "10.00" } },
    });

    const result = unwrap(await platform.capabilities.validate({ tenant: TENANT, draft }));
    assert.equal(result.preview!.passed, true, "a currency mismatch with the sample is not the offer's fault");
    assert.ok(result.preview!.appliesTo > 0);
  });

  test("the unit is inferred from wherever the offer declares one", () => {
    const build = (draft: Parameters<typeof simpleDraft>[0]) =>
      createValueExchange({
        tenant: TENANT,
        draft: simpleDraft(draft),
        actor: "t",
        at: "0",
        ids: sequentialIdFactory(),
      });

    assert.equal(inferUnit(build({ limits: { minimumBase: { unit: "JPY", decimal: "100" } } })), "JPY");
    assert.equal(
      inferUnit(build({ benefits: [{ id: "b", type: "flat", params: { amount: "5" }, effect: "points_grant", unit: "POINTS" }] })),
      "POINTS",
    );
    assert.equal(
      inferUnit(
        build({
          conditions: { op: "gte", left: { path: "cart.subtotal" }, right: { amount: { unit: "EUR", decimal: "1.00" } } },
        }),
      ),
      "EUR",
      "a money literal buried in the conditions is found",
    );
    assert.equal(inferUnit(build({})), undefined, "nothing declared means nothing inferred");
  });

  test("largestBenefit reports the worst case across the samples", async () => {
    const report = await previewDraft(
      simpleDraft({ benefits: [{ id: "d", type: "percentage", params: { rate: "10" }, effect: "price_reduction" }] }),
    );
    const largest = largestBenefit(report);
    assert.ok(largest);
    // 10% of the 5,000.00 high-value sample.
    assert.equal(toDecimal(largest!), "500.00");
  });
});

describe("absent values are not errors", () => {
  test("a cart condition does not break discovery when there is no cart", async () => {
    const platform = await funded();
    await publish(
      platform,
      simpleDraft({
        conditions: { op: "gte", left: { path: "cart.subtotal" }, right: { amount: { unit: "USD", decimal: "50.00" } } },
      }),
    );

    // Discovery legitimately runs before a basket exists. Previously this
    // errored, which failed the entire discovery response for every offer.
    const discovered = await platform.capabilities.discover({
      context: { tenant: TENANT, unit: "USD", subject: { id: "browsing" } },
    });
    assert.equal(discovered.ok, true, "one cart-based offer must not break discovery");
    assert.equal(unwrap(discovered).results.length, 0, "it simply does not qualify yet");
  });

  test("a type mismatch is still an error", async () => {
    const platform = await funded();
    await publishUnchecked(platform, simpleDraft({ conditions: brokenCondition }));

    const result = await platform.capabilities.apply({ context: cartContext() });
    assert.equal(result.ok, false, "comparing a string to a number remains an authoring bug");
    assert.equal(result.ok === false && result.error.code, "RULE_ERROR");
  });
});

describe("explanations", () => {
  test("a decision reads as prose", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft({ name: "Ten percent" }));
    const quote = unwrap(await platform.capabilities.apply({ context: cartContext() }));

    const explanation = explainDecision(quote.decision);
    assert.match(explanation.summary, /1 offer\(s\) applied/);
    assert.match(explanation.summary, /10\.00 USD/);
    assert.match(explanation.details[0]!, /Ten percent/);
  });

  test("a rejection names the check in customer language", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft({ scope: { channels: ["pos"] } }));
    const quote = unwrap(await platform.capabilities.apply({ context: cartContext({ channel: "web" }) }));

    const explanation = explainOffer(quote.decision, quote.decision.rejected[0]!.valueExchangeId);
    assert.match(explanation.summary, /not available on this channel/);
    assert.ok(explanation.details.some((line) => line.includes("channel")));
  });

  test("a condition failure surfaces the predicate that decided it", async () => {
    const platform = await funded();
    await publish(
      platform,
      simpleDraft({
        conditions: { op: "gte", left: { path: "cart.subtotal" }, right: { amount: { unit: "USD", decimal: "500.00" } } },
      }),
    );
    const quote = unwrap(await platform.capabilities.apply({ context: cartContext() }));

    const explanation = explainOffer(quote.decision, quote.decision.rejected[0]!.valueExchangeId);
    assert.ok(
      explanation.details.some((line) => line.includes("gte")),
      "the rule trace is wasted unless the deciding predicate is surfaced",
    );
  });

  test("an unknown offer says so rather than guessing", async () => {
    const platform = await funded();
    await publish(platform, simpleDraft());
    const quote = unwrap(await platform.capabilities.apply({ context: cartContext() }));

    const explanation = explainOffer(quote.decision, "vx_does_not_exist");
    assert.match(explanation.summary, /not considered/);
  });

  test("a preview report renders for an author", async () => {
    const platform = await funded();
    const result = unwrap(await platform.capabilities.validate({ tenant: TENANT, draft: simpleDraft() }));
    const rendered = renderExplanation(explainPreview(result.preview!));
    assert.match(rendered, /applies to \d+ of \d+ sample contexts/);
    assert.ok(rendered.includes("✓") || rendered.includes("✗"));
  });
});

describe("behavioural diff", () => {
  async function pair(before: Parameters<typeof simpleDraft>[0], after: Parameters<typeof simpleDraft>[0]) {
    const platform = await funded();
    const published = await publish(platform, simpleDraft(before));
    const diff = unwrap(
      await platform.capabilities.compareVersions({
        tenant: TENANT,
        valueExchangeId: published.id,
        draft: simpleDraft(after),
      }),
    );
    return diff;
  }

  test("a larger rate is reported as increasing exposure", async () => {
    const diff = await pair(
      { benefits: [{ id: "d", type: "percentage", params: { rate: "10" }, effect: "price_reduction" }] },
      { benefits: [{ id: "d", type: "percentage", params: { rate: "25" }, effect: "price_reduction" }] },
    );
    const change = diff.changes.find((entry) => entry.path === "benefits.d.params");
    assert.equal(change!.exposure, "increases");
    assert.equal(diff.increasesExposure, true);
  });

  test("a smaller rate decreases it", async () => {
    const diff = await pair(
      { benefits: [{ id: "d", type: "percentage", params: { rate: "25" }, effect: "price_reduction" }] },
      { benefits: [{ id: "d", type: "percentage", params: { rate: "5" }, effect: "price_reduction" }] },
    );
    assert.equal(diff.changes.find((entry) => entry.path === "benefits.d.params")!.exposure, "decreases");
  });

  test("removing a cap is caught, which a textual diff makes look trivial", async () => {
    const diff = await pair(
      {
        benefits: [
          { id: "d", type: "percentage", params: { rate: "10" }, effect: "price_reduction", cap: { decimal: "5.00" } },
        ],
      },
      { benefits: [{ id: "d", type: "percentage", params: { rate: "10" }, effect: "price_reduction" }] },
    );
    const change = diff.changes.find((entry) => entry.path === "benefits.d.cap");
    assert.equal(change!.exposure, "increases");
    assert.match(change!.note, /raised or removed/);
  });

  test("raising a redemption limit increases exposure; lowering a minimum spend does too", async () => {
    const raised = await pair({ limits: { totalRedemptions: 100 } }, { limits: { totalRedemptions: 1000 } });
    assert.equal(raised.changes.find((c) => c.path === "limits.totalRedemptions")!.exposure, "increases");

    const widened = await pair(
      { limits: { minimumBase: { unit: "USD", decimal: "50.00" } } },
      { limits: { minimumBase: { unit: "USD", decimal: "10.00" } } },
    );
    const change = widened.changes.find((c) => c.path === "limits.minimumBase")!;
    assert.equal(change.exposure, "increases", "a lower minimum widens the audience");
  });

  test("a changed condition is honest about not knowing", async () => {
    const diff = await pair({}, { conditions: { op: "always" } });
    const change = diff.changes.find((entry) => entry.path === "conditions")!;
    assert.equal(change.exposure, "unknown");
    assert.match(change.note, /preview both versions/);
  });

  test("an identical revision reports no behavioural change", async () => {
    const diff = await pair({}, {});
    assert.deepEqual(diff.changes, []);
    assert.equal(diff.increasesExposure, false);
    assert.match(diff.summary, /No behavioural change/);
  });
});
