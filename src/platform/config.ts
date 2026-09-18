/**
 * Platform configuration.
 *
 * Every tuning constant that was a module-level literal, in one place, with the
 * reasoning attached. A number compiled into an engine is a decision made on
 * behalf of a deployment that may not share the assumptions behind it.
 *
 * These are *safety and cost* parameters, not business rules. Business
 * variation lives in registries; this is "how much work will we do before we
 * refuse", which is an operator's question.
 */

export interface RuleLimitsConfig {
  /** Maximum nesting depth of a condition. Bounds recursion. */
  readonly maxDepth: number;
  /** Maximum nodes and terms evaluated in one rule. Bounds total work. */
  readonly maxNodes: number;
}

export interface StackingConfig {
  /**
   * Above this many eligible exchanges, the search falls back to greedy.
   *
   * Subset selection is NP-hard, so this is the boundary between an optimal
   * answer and a bounded one. 2^10 = 1024 subsets, each a benefit resolution.
   * Raising it buys optimality and costs latency, quadratically.
   */
  readonly exhaustiveLimit: number;
}

export interface CounterConfig {
  /**
   * Hard cap on retained per-subject redemption timestamps.
   *
   * Bounded twice over - by the window a limit actually uses, and by this - so
   * a misconfigured window cannot grow a row without limit.
   */
  readonly maxRecentRetained: number;
}

export interface MaintenanceConfig {
  /** Reservations released per sweep. Keeps the job bounded on a bad day. */
  readonly sweepBatchLimit: number;
  /** How old a reservation must be before the sweep releases it. */
  readonly staleReservationSeconds: number;
}

export interface HealthConfig {
  /** Funding utilisation above which health degrades. */
  readonly fundingWarnPercent: number;
  /** A reservation older than this counts as stale for the health check. */
  readonly staleReservationSeconds: number;
}

export interface TelemetryConfig {
  /** Samples retained per histogram series. */
  readonly maxSamples: number;
  /** Events retained before the oldest is dropped. */
  readonly maxEvents: number;
}

export interface RiskConfig {
  /** Score at or above which an interaction is flagged for review. */
  readonly reviewThreshold: number;
  /** Score at or above which an interaction is refused. */
  readonly blockThreshold: number;
}

/**
 * Resolution of a ranking feature's score.
 *
 * Features return 0..`scale`. It is configuration rather than a constant
 * because it sets how finely two close offers can be separated, and a
 * deployment ranking thousands of near-identical items needs more room than
 * one ranking six.
 */
export interface RankingConfig {
  readonly scale: number;
}

export interface PlatformConfig {
  readonly rules: RuleLimitsConfig;
  readonly stacking: StackingConfig;
  readonly counters: CounterConfig;
  readonly maintenance: MaintenanceConfig;
  readonly health: HealthConfig;
  readonly telemetry: TelemetryConfig;
  readonly risk: RiskConfig;
  readonly ranking: RankingConfig;
}

export const DEFAULT_CONFIG: PlatformConfig = {
  rules: { maxDepth: 32, maxNodes: 5_000 },
  stacking: { exhaustiveLimit: 10 },
  counters: { maxRecentRetained: 512 },
  maintenance: { sweepBatchLimit: 500, staleReservationSeconds: 3_600 },
  health: { fundingWarnPercent: 80, staleReservationSeconds: 3_600 },
  telemetry: { maxSamples: 1_024, maxEvents: 512 },
  risk: { reviewThreshold: 50, blockThreshold: 80 },
  ranking: { scale: 10_000 },
};

/** Merge a partial override over the defaults, one level deep per section. */
export function resolveConfig(overrides: DeepPartial<PlatformConfig> = {}): PlatformConfig {
  return {
    rules: { ...DEFAULT_CONFIG.rules, ...overrides.rules },
    stacking: { ...DEFAULT_CONFIG.stacking, ...overrides.stacking },
    counters: { ...DEFAULT_CONFIG.counters, ...overrides.counters },
    maintenance: { ...DEFAULT_CONFIG.maintenance, ...overrides.maintenance },
    health: { ...DEFAULT_CONFIG.health, ...overrides.health },
    telemetry: { ...DEFAULT_CONFIG.telemetry, ...overrides.telemetry },
    risk: { ...DEFAULT_CONFIG.risk, ...overrides.risk },
    ranking: { ...DEFAULT_CONFIG.ranking, ...overrides.ranking },
  };
}

export type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };
