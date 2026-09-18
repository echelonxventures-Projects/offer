/**
 * Decision Engine.
 *
 * The orchestrator. It gathers candidates, asks the Eligibility Engine about
 * each, hands the survivors to the Stacking Engine under the chosen objective,
 * and emits a `Decision` - a complete, hashable account of what would happen
 * and why, including every rejection.
 *
 * A decision changes nothing. It commits no budget, consumes no limit and moves
 * no value. That is the Execution Engine's job, and keeping the two apart is
 * what lets a price be quoted a hundred times and taken once.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import { hashValue } from "../kernel/hash.ts";
import type { ResolvedContext } from "../context/context.ts";
import type { Grant, ValueExchange } from "../model/value-exchange.ts";
import type { Amount } from "../universal/economic/amount.ts";
import type { Registry } from "../registry/registry.ts";
import type { EngineDeps } from "./deps.ts";
import { METRICS } from "../observability/metrics.ts";
import type { EligibilityVerdict } from "./eligibility.ts";
import { EligibilityEngine } from "./eligibility.ts";
import { BenefitResolutionEngine } from "./benefit-resolution.ts";
import type { AppliedExchange, ConflictNote } from "./stacking.ts";
import { StackingEngine } from "./stacking.ts";
import type { DecisionObjective } from "./objectives.ts";
import { DEFAULT_OBJECTIVE } from "./objectives.ts";

export interface DecisionRequest {
  readonly context: ResolvedContext;
  /** Restrict the candidate set. Omit to consider every active exchange. */
  readonly candidateIds?: readonly string[];
  /** Codes the subject presented. */
  readonly presentedCodes?: readonly string[];
  /** Objective key. Defaults to max_subject_value. */
  readonly objective?: string;
  /** Include exchanges that failed, with their full check list. */
  readonly includeRejected?: boolean;
}

export interface RejectedExchange {
  readonly valueExchangeId: string;
  readonly name: string;
  readonly reason: string;
  readonly verdict: EligibilityVerdict;
}

export interface Decision {
  readonly id: string;
  readonly tenant: string;
  readonly reality: string;
  readonly correlationId: string;
  readonly objective: string;
  readonly at: string;

  readonly applied: readonly AppliedExchange[];
  readonly payableReduction: Amount;
  readonly remainingPayable: Amount;
  readonly granted: readonly Amount[];

  readonly rejected: readonly RejectedExchange[];
  readonly displaced: readonly ConflictNote[];

  /**
   * The registry bundle that produced this decision.
   *
   * A decision is a pure function of its context *and* the loaded registries.
   * Recording only the context left a hole: a replay could differ because a
   * benefit type was added, and nothing would say so.
   */
  readonly bundle: string;

  readonly searchMode: "exhaustive" | "greedy";
  readonly combinationsConsidered: number;
  readonly candidatesConsidered: number;

  /** How the context was assembled, carried for replay. */
  readonly contextTrace: ResolvedContext["trace"];
  /** Hash over everything above; the audit record chains this. */
  readonly hash: string;
}

export class DecisionEngine {
  readonly #deps: EngineDeps;
  readonly #eligibility: EligibilityEngine;
  readonly #benefits: BenefitResolutionEngine;
  readonly #stacking: StackingEngine;
  readonly #objectives: Registry<DecisionObjective>;

  readonly #bundleId: () => string;

  constructor(
    deps: EngineDeps,
    objectives: Registry<DecisionObjective>,
    exhaustiveLimit?: number,
    bundleId: () => string = () => "unversioned",
  ) {
    this.#deps = deps;
    this.#objectives = objectives;
    this.#bundleId = bundleId;
    this.#eligibility = new EligibilityEngine(deps);
    this.#benefits = new BenefitResolutionEngine(deps);
    this.#stacking = new StackingEngine(this.#benefits, exhaustiveLimit);
  }

  get eligibility(): EligibilityEngine {
    return this.#eligibility;
  }

  get benefits(): BenefitResolutionEngine {
    return this.#benefits;
  }

  async decide(request: DecisionRequest): Promise<Result<Decision>> {
    const { context } = request;
    const labels = { tenant: context.tenant, reality: context.reality };
    const stop = this.#deps.telemetry.timer(METRICS.decisionDuration, labels);

    const objectiveKey = request.objective ?? DEFAULT_OBJECTIVE;
    const objective = this.#objectives.require(objectiveKey);
    if (!objective.ok) return objective;

    const candidates = await this.#gatherCandidates(request);
    if (!candidates.ok) return candidates;

    const grants = await this.#loadGrants(context);
    if (!grants.ok) return grants;

    const eligible: ValueExchange[] = [];
    const rejected: RejectedExchange[] = [];

    for (const exchange of candidates.value) {
      const verdict = await this.#eligibility.evaluate({
        exchange,
        context,
        ...(request.presentedCodes === undefined ? {} : { presentedCodes: request.presentedCodes }),
        grants: grants.value,
      });
      if (!verdict.ok) return verdict;

      if (verdict.value.eligible) {
        eligible.push(exchange);
      } else {
        // Break failures down by check. "Which check is refusing people today"
        // is the question an operator actually asks, and a single failure
        // counter cannot answer it.
        const failed = verdict.value.checks.find((check) => !check.passed);
        if (failed) {
          this.#deps.telemetry.count(METRICS.eligibilityFailed, 1, {
            tenant: context.tenant,
            check: failed.check,
          });
        }
      }

      if (!verdict.value.eligible && request.includeRejected !== false) {
        rejected.push({
          valueExchangeId: exchange.id,
          name: exchange.name,
          reason: verdict.value.primaryReason ?? "not eligible",
          verdict: verdict.value,
        });
      }
    }

    const outcome = this.#stacking.select(eligible, context, (combination) =>
      objective.value.score(combination, context),
    );
    if (!outcome.ok) return outcome;

    const body = {
      tenant: context.tenant,
      reality: context.reality,
      correlationId: context.correlationId,
      objective: objectiveKey,
      at: context.instant.tick.toString(),
      applied: outcome.value.best.applied,
      payableReduction: outcome.value.best.payableReduction,
      remainingPayable: outcome.value.best.remainingPayable,
      granted: outcome.value.best.granted,
      rejected,
      displaced: outcome.value.displaced,
      searchMode: outcome.value.searchMode,
      combinationsConsidered: outcome.value.combinationsConsidered,
      candidatesConsidered: candidates.value.length,
      contextTrace: context.trace,
    };

    stop();
    const telemetry = this.#deps.telemetry;
    telemetry.observe(METRICS.decisionCandidates, candidates.value.length, { tenant: context.tenant });
    telemetry.observe(METRICS.decisionEligible, eligible.length, { tenant: context.tenant });
    telemetry.observe(METRICS.decisionApplied, outcome.value.best.applied.length, { tenant: context.tenant });
    telemetry.count(METRICS.decisionSearchMode, 1, { tenant: context.tenant, mode: outcome.value.searchMode });
    telemetry.observe(METRICS.decisionReduction, Number(outcome.value.best.payableReduction.minor), {
      tenant: context.tenant,
      unit: outcome.value.best.payableReduction.unit,
    });

    if (outcome.value.searchMode === "greedy") {
      telemetry.event({
        name: METRICS.decisionSearchMode,
        severity: "warn",
        message: `stacking fell back to a greedy search over ${eligible.length} eligible exchanges; the chosen combination may not be optimal`,
        labels: { tenant: context.tenant },
        data: { eligible: eligible.length, considered: outcome.value.combinationsConsidered },
      });
    }

    // `bundle` is provenance, not content, so it is recorded but NOT hashed.
    //
    // Hashing it would make every decision fail to reproduce whenever any
    // registry changed, collapsing two genuinely different questions - "did
    // this decision reproduce?" and "was the platform running the same rules?" -
    // into one, and losing the ability to say that an unrelated registration
    // did not affect the outcome.
    return ok({
      id: this.#deps.ids.next("dec"),
      ...body,
      bundle: this.#bundleId(),
      hash: hashValue(body),
    });
  }

  async #gatherCandidates(request: DecisionRequest): Promise<Result<ValueExchange[]>> {
    const { context } = request;

    if (request.candidateIds) {
      const found: ValueExchange[] = [];
      for (const id of request.candidateIds) {
        const exchange = await this.#deps.store.exchanges.get(context.tenant, id);
        if (!exchange.ok) return exchange;
        found.push(exchange.value);
      }
      return ok(found);
    }

    const active = await this.#deps.store.exchanges.find(context.tenant, {
      state: "active",
      reality: context.reality,
    });
    if (!active.ok) return active;

    // Visibility governs *discovery*, not decisioning. A private exchange - an
    // affiliate commission, a negotiated partner rate - must still apply when
    // its conditions hold, even though no customer will ever browse it. What
    // stops it applying to the wrong subject is its conditions and its
    // acquisition mode, which is where that decision belongs. The Discovery
    // Engine is the one that hides private exchanges from a listing.
    const candidates = new Map(active.value.map((x) => [x.id, x]));
    for (const code of request.presentedCodes ?? []) {
      const found = await this.#deps.store.exchanges.byCode(context.tenant, code);
      if (!found.ok) return found;
      if (found.value) candidates.set(found.value.id, found.value);
    }
    return ok([...candidates.values()].sort((a, b) => a.id.localeCompare(b.id)));
  }

  async #loadGrants(context: ResolvedContext): Promise<Result<Grant[]>> {
    if (!context.subject.id) return ok([]);
    return this.#deps.store.grants.forSubject(context.tenant, context.subject.id);
  }
}
