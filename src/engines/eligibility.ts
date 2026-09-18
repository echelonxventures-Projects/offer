/**
 * Eligibility Engine.
 *
 * Answers one question about one value exchange: may this apply, here, now, to
 * this subject? It answers with a verdict *and every check it ran*, passed or
 * failed, because "why didn't I get the discount" is the question this platform
 * will be asked more than any other.
 *
 * Checks run cheapest-first and do not short-circuit the record: an exchange
 * that fails on the window still reports what the other checks would have said,
 * so a merchant debugging a campaign sees the whole picture in one call.
 * Expensive checks (the rule evaluation) are skipped once something structural
 * has already failed - the trace says so explicitly rather than silently.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { ResolvedContext } from "../context/context.ts";
import type { Grant, ValueExchange } from "../model/value-exchange.ts";
import { REDEEMABLE_STATES } from "../model/lifecycle.ts";
import type { RuleTraceEntry } from "../rules/ast.ts";
import { compare, fromDecimal, zero } from "../universal/economic/amount.ts";
import { findBreach, recentWindowFor } from "../adapters/limit-rules.ts";
import type { EngineDeps } from "./deps.ts";
import { METRICS } from "../observability/metrics.ts";

export interface EligibilityCheck {
  /** Stable identifier so consoles and tests can assert on it. */
  readonly check: string;
  readonly passed: boolean;
  readonly detail?: string;
  /** True when the check was not run because an earlier one already failed. */
  readonly skipped?: boolean;
}

export interface EligibilityVerdict {
  readonly valueExchangeId: string;
  readonly eligible: boolean;
  readonly checks: readonly EligibilityCheck[];
  /** First failure, which is what a UI should show. */
  readonly primaryReason?: string;
  readonly ruleTrace?: readonly RuleTraceEntry[];
}

export interface EligibilityInput {
  readonly exchange: ValueExchange;
  readonly context: ResolvedContext;
  /** Codes the caller presented in this request. */
  readonly presentedCodes?: readonly string[];
  /** Grants the subject already holds, pre-loaded by the decision engine. */
  readonly grants?: readonly Grant[];
}

export class EligibilityEngine {
  readonly #deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
  }

  async evaluate(input: EligibilityInput): Promise<Result<EligibilityVerdict>> {
    const { exchange, context } = input;
    const checks: EligibilityCheck[] = [];
    let structurallyFailed = false;

    const record = (check: string, passed: boolean, detail?: string): boolean => {
      checks.push(detail === undefined ? { check, passed } : { check, passed, detail });
      if (!passed) structurallyFailed = true;
      return passed;
    };
    const skip = (check: string, why: string) => {
      checks.push({ check, passed: false, skipped: true, detail: why });
    };

    /* 1. Reality ------------------------------------------------------- */
    const realities = exchange.scope.realities;
    record(
      "reality",
      realities === undefined || realities.includes(context.reality),
      `context reality '${context.reality}'`,
    );

    /* 2. Lifecycle ----------------------------------------------------- */
    record("lifecycle", REDEEMABLE_STATES.includes(exchange.state), `state '${exchange.state}'`);

    /* 3. Temporal window ----------------------------------------------- */
    if (exchange.window) {
      const inside = this.#deps.temporal.contains(exchange.window, context.instant);
      if (!inside.ok) return inside;
      record("window", inside.value.inside, inside.value.reason ?? "inside window");
    } else {
      record("window", true, "no window; always live");
    }

    /* 4. Spatial scope -------------------------------------------------- */
    const spatialScope = exchange.scope.spatial;
    if (spatialScope && (spatialScope.include?.length || spatialScope.exclude?.length)) {
      if (!context.spatial.place) {
        record("spatial", false, "exchange is place-scoped but the context has no place");
      } else {
        const verdict = this.#deps.spatial.evaluateScope(spatialScope, context.spatial.place);
        if (!verdict.ok) return verdict;
        record(
          "spatial",
          verdict.value.inside,
          verdict.value.excludedBy
            ? `excluded by ${verdict.value.excludedBy}`
            : verdict.value.matchedBy
              ? `matched ${verdict.value.matchedBy}`
              : `place '${context.spatial.place}' is out of scope`,
        );
      }
    } else {
      record("spatial", true, "unscoped");
    }

    /* 5. Channel -------------------------------------------------------- */
    const channels = exchange.scope.channels;
    if (channels && channels.length > 0) {
      record(
        "channel",
        context.channel !== undefined && channels.includes(context.channel),
        `context channel '${context.channel ?? "none"}'`,
      );
    } else {
      record("channel", true, "all channels");
    }

    /* 6. Merchant overlap ----------------------------------------------- */
    const merchants = exchange.scope.merchants;
    if (merchants && merchants.length > 0) {
      const inCart = new Set((context.cart?.lines ?? []).map((line) => line.merchant).filter(Boolean));
      const overlap = merchants.filter((m) => inCart.has(m));
      record("merchant", overlap.length > 0, overlap.length > 0 ? `matched ${overlap.join(", ")}` : "no matching lines");
    } else {
      record("merchant", true, "all merchants");
    }

    /* 7. Acquisition ----------------------------------------------------- */
    const acquisition = this.#checkAcquisition(input);
    record("acquisition", acquisition.passed, acquisition.detail);

    /* 8. Minimum base ----------------------------------------------------- */
    const minimum = exchange.limits.minimumBase;
    if (minimum) {
      const unit = this.#deps.economic.units.require(minimum.unit);
      if (!unit.ok) return unit;
      const threshold = fromDecimal(minimum.unit, minimum.decimal, unit.value.scale);
      const base = context.cart?.subtotal ?? zero(minimum.unit, unit.value.scale);
      const cmp = compare(base, threshold);
      if (!cmp.ok) {
        record("minimum_base", false, cmp.error.message);
      } else {
        record("minimum_base", cmp.value >= 0, `base vs minimum ${minimum.decimal} ${minimum.unit}`);
      }
    } else {
      record("minimum_base", true, "no minimum");
    }

    /* 9. Limits ------------------------------------------------------------ */
    const limits = await this.#checkLimits(exchange, context);
    if (!limits.ok) return limits;
    for (const check of limits.value) {
      record(check.check, check.passed, check.detail);
    }

    /* 10. Conditions -------------------------------------------------------- */
    let ruleTrace: readonly RuleTraceEntry[] | undefined;
    if (structurallyFailed) {
      skip("conditions", "not evaluated: an earlier check already failed");
    } else {
      const evaluated = this.#deps.evaluator.evaluate(exchange.conditions, context);
      if (!evaluated.ok) {
        // A broken rule is not an ineligible subject. It is an authoring bug,
        // and it must surface as one rather than as a silent non-qualification.
        // It is emitted at error severity because the offer is now silently
        // delivering nothing until somebody fixes the condition.
        this.#deps.telemetry.count(METRICS.ruleError, 1, { tenant: exchange.tenant });
        this.#deps.telemetry.event({
          name: METRICS.ruleError,
          severity: "error",
          message: `condition on '${exchange.id}' could not be evaluated: ${evaluated.error.message}`,
          labels: { tenant: exchange.tenant },
          data: { valueExchangeId: exchange.id, name: exchange.name },
        });
        return evaluated;
      }
      this.#deps.telemetry.observe(METRICS.ruleNodes, evaluated.value.nodesEvaluated, { tenant: exchange.tenant });
      ruleTrace = evaluated.value.trace;
      record(
        "conditions",
        evaluated.value.satisfied,
        exchange.conditions ? `${evaluated.value.nodesEvaluated} node(s) evaluated` : "no conditions",
      );
    }

    const failed = checks.find((c) => !c.passed);
    return ok({
      valueExchangeId: exchange.id,
      eligible: failed === undefined,
      checks,
      ...(failed === undefined ? {} : { primaryReason: `${failed.check}: ${failed.detail ?? "failed"}` }),
      ...(ruleTrace === undefined ? {} : { ruleTrace }),
    });
  }

  #checkAcquisition(input: EligibilityInput): { passed: boolean; detail: string } {
    const { exchange, context, presentedCodes = [], grants = [] } = input;
    const relevant = grants.filter(
      (g) => g.valueExchangeId === exchange.id && (g.state === "issued" || g.state === "activated"),
    );

    switch (exchange.acquisition.mode) {
      case "automatic":
        return { passed: true, detail: "applies automatically" };

      case "code": {
        const expected = exchange.acquisition.code?.toUpperCase();
        const presented = presentedCodes.map((c) => c.trim().toUpperCase());
        if (exchange.acquisition.codeSharing === "unique") {
          const held = relevant.find((g) => g.code && presented.includes(g.code.toUpperCase()));
          return held
            ? { passed: true, detail: `unique code accepted (grant ${held.id})` }
            : { passed: false, detail: "no matching unique code presented" };
        }
        return expected !== undefined && presented.includes(expected)
          ? { passed: true, detail: "shared code accepted" }
          : { passed: false, detail: "code not presented" };
      }

      case "issued":
      case "earned":
      case "referred": {
        if (context.subject.anonymous) {
          return { passed: false, detail: `'${exchange.acquisition.mode}' requires an identified subject` };
        }
        const usable = relevant.find((g) => g.uses < g.maxUses);
        if (!usable) return { passed: false, detail: "subject holds no usable grant" };
        if (exchange.acquisition.requiresActivation && usable.state !== "activated") {
          return { passed: false, detail: "grant has not been activated" };
        }
        return { passed: true, detail: `grant ${usable.id} (${usable.uses}/${usable.maxUses} used)` };
      }
    }
  }

  /**
   * Advisory limit check.
   *
   * This reports "3/5 used" for the verdict and for a console. It is NOT what
   * authorises a redemption: the value can be stale the instant it is read, and
   * two callers can both see room where there is room for one. The
   * authoritative check is `CounterStore.tryConsume`, which enforces the same
   * rules atomically at reserve time.
   *
   * Both paths call `findBreach`, so the reason a customer is shown here is
   * word-for-word the reason the reservation would give.
   */
  async #checkLimits(
    exchange: ValueExchange,
    context: ResolvedContext,
  ): Promise<Result<EligibilityCheck[]>> {
    const limits = exchange.limits;
    const atSeconds = Number(context.instant.tick) / 1000;
    const window = recentWindowFor(limits);

    const snapshot = await this.#deps.store.counters.read({
      tenant: exchange.tenant,
      valueExchangeId: exchange.id,
      ...(context.subject.id === undefined ? {} : { subjectId: context.subject.id }),
      atSeconds,
      ...(window === undefined ? {} : { recentWindowSeconds: window }),
    });
    if (!snapshot.ok) return snapshot;

    const checks: EligibilityCheck[] = [];

    if (limits.totalIssuance !== undefined) {
      checks.push({
        check: "limit.total_issuance",
        passed: snapshot.value.issued <= limits.totalIssuance,
        detail: `${snapshot.value.issued}/${limits.totalIssuance}`,
      });
    }

    // Advisory mode: eligibility runs before benefits are resolved, so the
    // budget can only be checked for "any headroom left", not "would this
    // particular grant fit". The exact test happens at reserve.
    const breach = findBreach(snapshot.value, limits, context.subject.id, atSeconds, [], "advisory");
    if (breach) {
      checks.push({ check: breach.limit, passed: false, detail: breach.detail });
    } else {
      for (const [name, present] of [
        ["limit.total_redemptions", limits.totalRedemptions !== undefined],
        ["limit.per_subject", limits.perSubject !== undefined],
        ["limit.per_subject_per_period", limits.perSubjectPerPeriod !== undefined],
        ["limit.total_budget", limits.totalBudget !== undefined],
      ] as const) {
        if (present) checks.push({ check: name, passed: true, detail: "room remaining" });
      }
    }

    return ok(checks);
  }

}
