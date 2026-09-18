/**
 * Discovery Engine.
 *
 * "What can I get?" rather than "what do I get for this basket?". Runs the same
 * eligibility checks as the Decision Engine, then ranks what survived.
 *
 * Discovery deliberately reports each exchange standing alone. Showing a
 * customer a stacked total they will not receive - because the stack conflicts
 * once a real basket exists - is worse than showing less.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { ResolvedContext } from "../context/context.ts";
import type { Grant, ValueExchange } from "../model/value-exchange.ts";
import type { Amount } from "../universal/economic/amount.ts";
import type { EligibilityVerdict } from "./eligibility.ts";
import type { EligibilityEngine } from "./eligibility.ts";
import type { DiscoveryRanking, RankingCandidate, RankingExplanation, RankingInput } from "./ranking.ts";
import type { Registry } from "../registry/registry.ts";
import { compareKeys } from "../kernel/order.ts";
import type { BenefitResolutionEngine } from "./benefit-resolution.ts";
import type { EngineDeps } from "./deps.ts";

export interface DiscoveryQuery {
  readonly context: ResolvedContext;
  readonly profile?: string;
  /** Free-text match against name and description. Case-insensitive substring. */
  readonly text?: string;
  /** Include exchanges the subject is not eligible for, with their reasons. */
  readonly includeIneligible?: boolean;
  readonly limit?: number;
  /**
   * Key into the `discovery-ranking` registry. "value" (default) ranks by
   * computed benefit; "recommended" blends several features. An unknown key is
   * an error rather than a silent fallback - quietly ranking by something
   * other than what was asked for is worse than saying no.
   */
  readonly rank?: string;
}

export interface DiscoveredExchange {
  readonly valueExchangeId: string;
  readonly profile: string;
  readonly name: string;
  readonly description?: string;
  readonly eligible: boolean;
  /** Standalone value for this subject, in the context unit. */
  readonly indicativeValue?: Amount;
  readonly primaryReason?: string;
  readonly verdict: EligibilityVerdict;
  /** Present when the chosen ranking can show its working. */
  readonly ranking?: RankingExplanation;
}

export class DiscoveryEngine {
  readonly #deps: EngineDeps;
  readonly #eligibility: EligibilityEngine;
  readonly #benefits: BenefitResolutionEngine;
  readonly #rankings: Registry<DiscoveryRanking>;
  readonly #scale: number;

  constructor(
    deps: EngineDeps,
    eligibility: EligibilityEngine,
    benefits: BenefitResolutionEngine,
    rankings: Registry<DiscoveryRanking>,
    scale: number,
  ) {
    this.#deps = deps;
    this.#eligibility = eligibility;
    this.#benefits = benefits;
    this.#rankings = rankings;
    this.#scale = scale;
  }

  async discover(query: DiscoveryQuery): Promise<Result<DiscoveredExchange[]>> {
    const { context } = query;
    const found = await this.#deps.store.exchanges.find(context.tenant, {
      state: "active",
      reality: context.reality,
      ...(query.profile === undefined ? {} : { profile: query.profile }),
    });
    if (!found.ok) return found;

    const grants = context.subject.id
      ? await this.#deps.store.grants.forSubject(context.tenant, context.subject.id)
      : ok<Grant[]>([]);
    if (!grants.ok) return grants;

    const needle = query.text?.toLowerCase();
    const results: DiscoveredExchange[] = [];

    for (const exchange of found.value) {
      if (exchange.visibility === "private") continue;
      if (needle && !matchesText(exchange, needle)) continue;

      const verdict = await this.#eligibility.evaluate({ exchange, context, grants: grants.value });
      if (!verdict.ok) return verdict;
      if (!verdict.value.eligible && !query.includeIneligible) continue;

      let indicativeValue: Amount | undefined;
      if (verdict.value.eligible) {
        const resolution = this.#benefits.resolve({ exchange, context });
        if (!resolution.ok) return resolution;
        indicativeValue = resolution.value.rankingValue;
      }

      results.push({
        valueExchangeId: exchange.id,
        profile: exchange.profile,
        name: exchange.name,
        ...(exchange.description === undefined ? {} : { description: exchange.description }),
        eligible: verdict.value.eligible,
        ...(indicativeValue === undefined ? {} : { indicativeValue }),
        ...(verdict.value.primaryReason === undefined ? {} : { primaryReason: verdict.value.primaryReason }),
        verdict: verdict.value,
      });
    }

    const ranking = this.#rankings.require(query.rank ?? "value");
    if (!ranking.ok) return ranking;

    const ranked = this.#rank(results, found.value, context, ranking.value);
    return ok(query.limit === undefined ? ranked : ranked.slice(0, query.limit));
  }

  #rank(
    results: DiscoveredExchange[],
    exchanges: readonly ValueExchange[],
    context: ResolvedContext,
    ranking: DiscoveryRanking,
  ): DiscoveredExchange[] {
    const byId = new Map(exchanges.map((exchange) => [exchange.id, exchange]));
    const candidateFor = (result: DiscoveredExchange): RankingCandidate => {
      const exchange = byId.get(result.valueExchangeId);
      return {
        valueExchangeId: result.valueExchangeId,
        name: result.name,
        eligible: result.eligible,
        ...(result.indicativeValue === undefined ? {} : { indicativeValue: result.indicativeValue }),
        ...(exchange === undefined ? {} : { exchange }),
      };
    };

    const cohort = results.map(candidateFor);
    const inputFor = (result: DiscoveredExchange): RankingInput => ({
      candidate: candidateFor(result),
      cohort,
      context,
      scale: this.#scale,
    });

    const sorted = [...results].sort((a, b) => {
      // Eligible items always outrank ineligible ones, whatever the ranking
      // says. A ranking orders what is on offer; something the subject cannot
      // have is not on offer, and no weighting should be able to promote it.
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      const order = ranking.compare(inputFor(a), inputFor(b));
      // Ties break on id rather than relying on sort stability, which would
      // inherit whatever order the store happened to return rows in.
      return order || compareKeys(a.valueExchangeId, b.valueExchangeId);
    });

    if (ranking.explain === undefined) return sorted;
    const explain = ranking.explain.bind(ranking);
    return sorted.map((result) => ({ ...result, ranking: explain(inputFor(result)) }));
  }
}

function matchesText(exchange: ValueExchange, needle: string): boolean {
  return (
    exchange.name.toLowerCase().includes(needle) ||
    (exchange.description?.toLowerCase().includes(needle) ?? false)
  );
}
