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
  /** "value" (default) ranks by computed benefit; "priority" by author intent. */
  readonly rank?: "value" | "priority" | "name";
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
}

export class DiscoveryEngine {
  readonly #deps: EngineDeps;
  readonly #eligibility: EligibilityEngine;
  readonly #benefits: BenefitResolutionEngine;

  constructor(deps: EngineDeps, eligibility: EligibilityEngine, benefits: BenefitResolutionEngine) {
    this.#deps = deps;
    this.#eligibility = eligibility;
    this.#benefits = benefits;
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

    const ranked = this.#rank(results, found.value, query.rank ?? "value");
    return ok(query.limit === undefined ? ranked : ranked.slice(0, query.limit));
  }

  #rank(
    results: DiscoveredExchange[],
    exchanges: readonly ValueExchange[],
    mode: "value" | "priority" | "name",
  ): DiscoveredExchange[] {
    const priorityOf = (id: string) => exchanges.find((x) => x.id === id)?.priority ?? 0;
    return [...results].sort((a, b) => {
      // Eligible items always outrank ineligible ones, whatever the mode.
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (mode === "name") return a.name.localeCompare(b.name);
      if (mode === "priority") return priorityOf(b.valueExchangeId) - priorityOf(a.valueExchangeId);
      const av = a.indicativeValue?.minor ?? 0n;
      const bv = b.indicativeValue?.minor ?? 0n;
      if (av !== bv) return bv > av ? 1 : -1;
      return priorityOf(b.valueExchangeId) - priorityOf(a.valueExchangeId) || a.name.localeCompare(b.name);
    });
  }
}

function matchesText(exchange: ValueExchange, needle: string): boolean {
  return (
    exchange.name.toLowerCase().includes(needle) ||
    (exchange.description?.toLowerCase().includes(needle) ?? false)
  );
}
