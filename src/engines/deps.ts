/**
 * Engine dependencies.
 *
 * One bag of authorities, registries and stores, assembled once by the platform
 * composition root and handed to every engine. Engines never construct their
 * own dependencies and never reach for a module-level singleton, which is what
 * makes a second tenant, a second reality or a replay harness possible without
 * touching engine code.
 */
import type { IdFactory } from "../kernel/ids.ts";
import type { Registry } from "../registry/registry.ts";
import type { TemporalAuthority } from "../universal/temporal/authority.ts";
import type { SpatialAuthority } from "../universal/spatial/authority.ts";
import type { EconomicAuthority } from "../universal/economic/authority.ts";
import type { Reality } from "../universal/reality/reality.ts";
import type { LifecycleTransition } from "../model/lifecycle.ts";
import type { BenefitType, EffectKind } from "../model/benefit.ts";
import type { FundingModel, PartyKind } from "../model/funding.ts";
import type { RuleEvaluator } from "../rules/evaluator.ts";
import type { PlatformStore } from "../adapters/store.ts";
import type { DomainProfile } from "../model/value-exchange.ts";

export interface EngineDeps {
  readonly temporal: TemporalAuthority;
  readonly spatial: SpatialAuthority;
  readonly economic: EconomicAuthority;
  readonly realities: Registry<Reality>;
  readonly lifecycle: Registry<LifecycleTransition>;
  readonly benefitTypes: Registry<BenefitType>;
  readonly effectKinds: Registry<EffectKind>;
  readonly fundingModels: Registry<FundingModel>;
  readonly partyKinds: Registry<PartyKind>;
  readonly profiles: Registry<DomainProfile & { key: string; label: string }>;
  readonly evaluator: RuleEvaluator;
  readonly store: PlatformStore;
  readonly ids: IdFactory;
}
