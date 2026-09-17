/**
 * Composition root.
 *
 * Everything the platform is made of is constructed here, once, and handed
 * downwards. There are no module-level singletons anywhere in `src`, which is
 * what makes it possible to run two tenants with different registries, or a
 * replay of last Tuesday, inside the same process.
 *
 * `GoipPlatform` is also the object that can describe itself: `describe()`
 * enumerates every registry and every entry, so the documentation of what this
 * deployment can do is generated from the deployment rather than written
 * alongside it and left to rot.
 */
import type { IdFactory } from "../kernel/ids.ts";
import { randomIdFactory } from "../kernel/ids.ts";
import type { Registry } from "../registry/registry.ts";
import { Registry as RegistryClass } from "../registry/registry.ts";

import { EconomicAuthority } from "../universal/economic/authority.ts";
import type { Clock } from "../universal/temporal/authority.ts";
import { TemporalAuthority } from "../universal/temporal/authority.ts";
import { SpatialAuthority } from "../universal/spatial/authority.ts";
import { realityRegistry } from "../universal/reality/reality.ts";

import { ContextResolutionEngine } from "../context/resolution-engine.ts";
import type { ContextResolver } from "../context/resolution-engine.ts";

import { RuleEvaluator } from "../rules/evaluator.ts";
import { ruleOperatorRegistry } from "../rules/operators.ts";
import { ruleFunctionRegistry } from "../rules/functions.ts";

import { lifecycleRegistry } from "../model/lifecycle.ts";
import { benefitTypeRegistry, effectKindRegistry } from "../model/benefit.ts";
import { DEFAULT_BENEFIT_TYPES } from "../model/benefit-types.ts";
import { fundingModelRegistry, partyKindRegistry } from "../model/funding.ts";
import type { DomainProfile } from "../model/value-exchange.ts";

import type { EngineDeps } from "../engines/deps.ts";
import { DecisionEngine } from "../engines/decision.ts";
import { ExecutionEngine } from "../engines/execution.ts";
import { GovernanceEngine, policyRegistry } from "../engines/governance.ts";
import { RiskEngine, riskSignalRegistry } from "../engines/risk.ts";
import { DiscoveryEngine } from "../engines/discovery.ts";
import { ReservationReaper } from "../engines/reaper.ts";
import { objectiveRegistry } from "../engines/objectives.ts";

import { AttributionEngine, attributionModelRegistry } from "../attribution/attribution.ts";
import { DEFAULT_PROFILES } from "../profiles/index.ts";

import type { PlatformStore } from "../adapters/store.ts";
import { MemoryPlatformStore } from "../adapters/memory-store.ts";
import { Capabilities } from "../capabilities/capabilities.ts";

export interface PlatformOptions {
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly store?: PlatformStore;
  /** Extra resolvers appended to the core context pipeline. */
  readonly contextResolvers?: readonly ContextResolver[];
}

export class GoipPlatform {
  readonly economic: EconomicAuthority;
  readonly temporal: TemporalAuthority;
  readonly spatial: SpatialAuthority;

  readonly store: PlatformStore;
  readonly ids: IdFactory;

  readonly context: ContextResolutionEngine;
  readonly decisions: DecisionEngine;
  readonly executions: ExecutionEngine;
  readonly governance: GovernanceEngine;
  readonly risk: RiskEngine;
  readonly discovery: DiscoveryEngine;
  readonly attribution: AttributionEngine;
  /** Operational sweep; run it on a schedule. Not a capability by design. */
  readonly reaper: ReservationReaper;

  readonly deps: EngineDeps;
  readonly capabilities: Capabilities;

  /** Every registry in the deployment, by name. The extension surface. */
  readonly registries: Record<string, Registry<{ key: string; label: string }>>;

  constructor(options: PlatformOptions = {}) {
    this.ids = options.ids ?? randomIdFactory();
    this.store = options.store ?? new MemoryPlatformStore();

    this.economic = new EconomicAuthority();
    this.temporal = new TemporalAuthority(options.clock ? { clock: options.clock } : {});
    this.spatial = new SpatialAuthority();

    const realities = realityRegistry();
    const operators = ruleOperatorRegistry();
    const functions = ruleFunctionRegistry();
    const benefitTypes = benefitTypeRegistry().registerAll(DEFAULT_BENEFIT_TYPES);
    const effectKinds = effectKindRegistry();
    const fundingModels = fundingModelRegistry();
    const partyKinds = partyKindRegistry();
    const lifecycle = lifecycleRegistry();
    const objectives = objectiveRegistry();
    const policies = policyRegistry();
    const riskSignals = riskSignalRegistry();
    const attributionModels = attributionModelRegistry();
    const profiles = new RegistryClass<DomainProfile>("domain-profile").registerAll(DEFAULT_PROFILES);

    const evaluator = new RuleEvaluator({
      temporal: this.temporal,
      spatial: this.spatial,
      economic: this.economic,
      operators,
      functions,
    });

    this.deps = {
      temporal: this.temporal,
      spatial: this.spatial,
      economic: this.economic,
      realities,
      lifecycle,
      benefitTypes,
      effectKinds,
      fundingModels,
      partyKinds,
      profiles,
      evaluator,
      store: this.store,
      ids: this.ids,
    };

    this.context = new ContextResolutionEngine({
      temporal: this.temporal,
      spatial: this.spatial,
      economic: this.economic,
      realities,
    });
    for (const resolver of options.contextResolvers ?? []) {
      this.context.resolvers.register(resolver);
    }

    this.decisions = new DecisionEngine(this.deps, objectives);
    this.executions = new ExecutionEngine(this.deps);
    this.governance = new GovernanceEngine(this.deps, policies);
    this.risk = new RiskEngine(this.deps, riskSignals);
    this.discovery = new DiscoveryEngine(this.deps, this.decisions.eligibility, this.decisions.benefits);
    this.attribution = new AttributionEngine(attributionModels, this.store.touchpoints);
    this.reaper = new ReservationReaper(this.deps, this.executions);

    this.registries = {
      "economic-unit": this.economic.units,
      "economic-unit-class": this.economic.unitClasses,
      "exchange-rate": this.economic.rates,
      chronology: this.temporal.chronologies,
      calendar: this.temporal.calendars,
      "temporal-zone": this.temporal.zones,
      "spatial-node": this.spatial.nodes,
      "spatial-node-kind": this.spatial.kinds,
      "coordinate-system": this.spatial.coordinateSystems,
      reality: realities,
      "rule-operator": operators,
      "rule-function": functions,
      "benefit-type": benefitTypes,
      "effect-kind": effectKinds,
      "funding-model": fundingModels,
      "party-kind": partyKinds,
      "lifecycle-transition": lifecycle,
      "decision-objective": objectives,
      policy: policies,
      "risk-signal": riskSignals,
      "attribution-model": attributionModels,
      "domain-profile": profiles,
      "context-resolver": this.context.resolvers,
    } as Record<string, Registry<{ key: string; label: string }>>;

    this.capabilities = new Capabilities(this);
  }

  /** Machine-readable inventory of this deployment's extension surface. */
  describe(): {
    registries: { name: string; entries: number; keys: string[] }[];
    totalEntries: number;
  } {
    const registries = Object.entries(this.registries)
      .map(([name, registry]) => ({ name, entries: registry.size, keys: registry.keys() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { registries, totalEntries: registries.reduce((sum, r) => sum + r.entries, 0) };
  }
}
