/**
 * Anomaly detection on decisions and settlement.
 *
 * The alerting built in Phase 2 answers "is a threshold breached?". That covers
 * the failures you predicted. This covers the ones you did not: a redemption
 * rate that quietly triples, a campaign that stops delivering overnight, a
 * release rate that climbs because a downstream service started timing out.
 *
 * Three commitments, and they are what separate this from a black box:
 *
 *  1. **Deterministic.** Integer statistics over closed buckets. The same
 *     history produces the same findings on every host, which means a finding
 *     can be reproduced in an incident review rather than argued about.
 *  2. **Explainable.** Every finding carries the observed value, the baseline
 *     it was judged against, and a sentence naming what it means. Nothing here
 *     may say only "anomalous".
 *  3. **Nothing is trained here.** Detectors are registered rules over a
 *     series. A deployment that has fitted a model elsewhere registers it as
 *     one more detector; the surface does not change and neither does the
 *     requirement to explain itself.
 *
 * Detectors describe; they do not act. A finding is evidence for a human or an
 * alert rule, never an automatic block - a false positive that pauses a live
 * campaign costs more than the anomaly it was guessing at.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { PlatformStore } from "../adapters/store.ts";
import type { Series, SeriesSet } from "./series.ts";
import { bucketAuditKinds, median, medianAbsoluteDeviation } from "./series.ts";
import { compareKeys } from "../kernel/order.ts";

export type AnomalySeverity = "info" | "investigate";

export interface AnomalyFinding {
  readonly detector: string;
  readonly series: string;
  readonly severity: AnomalySeverity;
  /** The value that triggered it. */
  readonly observed: number;
  /** What it was judged against. */
  readonly baseline: number;
  /** One sentence a human can act on. Never just "anomalous". */
  readonly detail: string;
}

export interface DetectorInput {
  readonly series: Series;
  /** Detectors read closed buckets only; the open one is still filling. */
  readonly counts: readonly number[];
  readonly config: AnomalyConfig;
}

export interface AnomalyDetector extends RegistryEntry {
  detect(input: DetectorInput): readonly AnomalyFinding[];
}

export interface AnomalyConfig {
  /**
   * How many MADs from the median counts as a deviation.
   *
   * Integer, because a fractional threshold invites tuning by feel. Three is
   * the conventional starting point and is not a finding about your traffic.
   */
  readonly deviations: number;
  /** Below this many buckets there is no baseline worth the name. */
  readonly minimumBuckets: number;
  /** Ignore series whose median is under this; small numbers are all noise. */
  readonly minimumBaseline: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  deviations: 3,
  minimumBuckets: 6,
  minimumBaseline: 5,
};

/* ------------------------------------------------------------------ *
 * Detectors
 * ------------------------------------------------------------------ */

function usable(input: DetectorInput): { baseline: number; spread: number } | undefined {
  const { counts, config } = input;
  if (counts.length < config.minimumBuckets) return undefined;
  // The most recent bucket is the one being judged, so it is excluded from the
  // baseline it is judged against. Including it drags the baseline towards the
  // value being tested and hides exactly the spikes worth catching.
  const history = counts.slice(0, -1);
  const baseline = median(history);
  if (baseline < config.minimumBaseline) return undefined;
  const spread = medianAbsoluteDeviation(history);
  return { baseline, spread };
}

export const DEFAULT_DETECTORS: AnomalyDetector[] = [
  {
    key: "volume_spike",
    label: "Volume spike",
    description: "The latest closed bucket is far above the recent median.",
    detect(input) {
      const stats = usable(input);
      if (stats === undefined) return [];
      const observed = input.counts[input.counts.length - 1] as number;
      // A spread of zero means perfectly steady traffic; any movement at all is
      // then notable, so fall back to the baseline itself as the scale.
      const scale = stats.spread === 0 ? Math.max(1, Math.trunc(stats.baseline / 2)) : stats.spread;
      const threshold = stats.baseline + input.config.deviations * scale;
      if (observed <= threshold) return [];
      return [{
        detector: "volume_spike",
        series: input.series.key,
        severity: "investigate" as const,
        observed,
        baseline: stats.baseline,
        detail: `${input.series.key} ran at ${observed} against a recent median of ${stats.baseline}; above ${threshold} is unusual for this series.`,
      }];
    },
  },
  {
    key: "volume_collapse",
    label: "Volume collapse",
    description:
      "The latest closed bucket is far below the recent median. Catches a campaign that stopped delivering, which nothing else here notices because zero errors are raised.",
    detect(input) {
      const stats = usable(input);
      if (stats === undefined) return [];
      const observed = input.counts[input.counts.length - 1] as number;
      const scale = stats.spread === 0 ? Math.max(1, Math.trunc(stats.baseline / 2)) : stats.spread;
      const threshold = stats.baseline - input.config.deviations * scale;
      if (observed >= threshold || observed >= stats.baseline) return [];
      return [{
        detector: "volume_collapse",
        series: input.series.key,
        severity: "investigate" as const,
        observed,
        baseline: stats.baseline,
        detail:
          observed === 0
            ? `${input.series.key} stopped entirely against a recent median of ${stats.baseline}. Nothing errors when a campaign quietly delivers nothing.`
            : `${input.series.key} ran at ${observed} against a recent median of ${stats.baseline}.`,
      }];
    },
  },
  {
    key: "sustained_shift",
    label: "Sustained shift",
    description:
      "The recent half of the window differs from the older half. Catches a drift too gradual for any single bucket to look wrong.",
    detect(input) {
      const { counts, config } = input;
      if (counts.length < Math.max(config.minimumBuckets, 4)) return [];
      const half = Math.floor(counts.length / 2);
      const older = median(counts.slice(0, half));
      const recent = median(counts.slice(half));
      if (older < config.minimumBaseline) return [];
      // A doubling or a halving. Expressed as integer comparisons so there is
      // no rounding to argue about at the boundary.
      const doubled = recent >= older * 2;
      const halved = recent * 2 <= older;
      if (!doubled && !halved) return [];
      return [{
        detector: "sustained_shift",
        series: input.series.key,
        severity: "info" as const,
        observed: recent,
        baseline: older,
        detail: `${input.series.key} has ${doubled ? "risen" : "fallen"} from a median of ${older} to ${recent} across the window. Gradual, so no single bucket looks wrong.`,
      }];
    },
  },
];

export function detectorRegistry(): Registry<AnomalyDetector> {
  return new Registry<AnomalyDetector>("anomaly-detector").registerAll(DEFAULT_DETECTORS);
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

export interface AnomalyRequest {
  readonly tenant: string;
  readonly nowTick: bigint;
  readonly bucketTicks: bigint;
  readonly buckets?: number;
  readonly kinds?: readonly string[];
  readonly maxRecords?: number;
}

export interface AnomalyReport {
  readonly findings: readonly AnomalyFinding[];
  readonly seriesExamined: number;
  readonly scanned: number;
  /** True when the record budget was hit, so the baseline may be short. */
  readonly truncated: boolean;
}

export class AnomalyEngine {
  readonly #store: PlatformStore;
  readonly #detectors: Registry<AnomalyDetector>;
  readonly #config: AnomalyConfig;

  constructor(store: PlatformStore, detectors: Registry<AnomalyDetector>, config = DEFAULT_ANOMALY_CONFIG) {
    this.#store = store;
    this.#detectors = detectors;
    this.#config = config;
  }

  async scan(request: AnomalyRequest): Promise<Result<AnomalyReport>> {
    const buckets = request.buckets ?? 12;
    const built = await bucketAuditKinds(this.#store, {
      tenant: request.tenant,
      bucketTicks: request.bucketTicks,
      nowTick: request.nowTick,
      buckets,
      ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
      ...(request.maxRecords === undefined ? {} : { maxRecords: request.maxRecords }),
    });
    if (!built.ok) return built;

    return ok({
      findings: this.#findings(built.value),
      seriesExamined: built.value.series.length,
      scanned: built.value.scanned,
      truncated: built.value.truncated,
    });
  }

  #findings(set: SeriesSet): AnomalyFinding[] {
    const findings: AnomalyFinding[] = [];
    for (const series of set.series) {
      const counts = series.buckets.filter((bucket) => bucket.closed).map((bucket) => bucket.count);
      for (const detector of this.#detectors.list()) {
        findings.push(...detector.detect({ series, counts, config: this.#config }));
      }
    }
    return findings.sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "investigate" ? -1 : 1) ||
        compareKeys(a.series, b.series) ||
        compareKeys(a.detector, b.detector),
    );
  }
}
