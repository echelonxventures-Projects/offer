/**
 * Bucketed counts over the audit chain.
 *
 * Anomaly detection needs a series before it needs statistics, and building
 * that series is where the determinism is won or lost. Two rules here:
 *
 *  - **Integer arithmetic only.** Counts are integers and bucket boundaries are
 *    integer division of a tick. No floating point touches a series, so two
 *    hosts cannot disagree about which bucket an event landed in.
 *  - **Buckets are closed before they are judged.** The bucket containing
 *    "now" is still filling. Comparing a half-finished bucket against full ones
 *    reports a collapse in volume every single time it runs, which is the
 *    classic way an alerting system teaches people to ignore it.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { PlatformStore } from "../adapters/store.ts";
import type { AuditRecord } from "../audit/audit-log.ts";
import { compareKeys } from "../kernel/order.ts";

export const SERIES_PAGE = 1_000;

export interface Bucket {
  /** Inclusive lower bound, in the chain's tick units. */
  readonly startTick: bigint;
  readonly count: number;
  /** False for the bucket still being filled; detectors skip it. */
  readonly closed: boolean;
}

export interface Series {
  readonly key: string;
  readonly buckets: readonly Bucket[];
}

export interface SeriesRequest {
  readonly tenant: string;
  /** Bucket width in ticks. */
  readonly bucketTicks: bigint;
  /** "Now", used to decide which bucket is still open. */
  readonly nowTick: bigint;
  /** How many closed buckets to keep, most recent last. */
  readonly buckets: number;
  /** Audit kinds to count. Absent means every kind, grouped by kind. */
  readonly kinds?: readonly string[];
  readonly maxRecords?: number;
}

export interface SeriesSet {
  readonly series: readonly Series[];
  readonly scanned: number;
  readonly truncated: boolean;
  readonly fromTick: bigint;
}

/**
 * Count audit records into buckets, one series per kind.
 *
 * Reads backwards from the head, because a series is about the recent past and
 * paging forward from genesis to reach it would be the unbounded-scan mistake
 * again. `maxRecords` bounds it; `truncated` says when the bound was reached.
 */
export async function bucketAuditKinds(
  store: PlatformStore,
  request: SeriesRequest,
): Promise<Result<SeriesSet>> {
  const width = request.bucketTicks;
  if (width <= 0n) {
    return ok({ series: [], scanned: 0, truncated: false, fromTick: request.nowTick });
  }

  // The open bucket starts here; everything at or after it is still filling.
  const openStart = (request.nowTick / width) * width;
  const oldestStart = openStart - width * BigInt(request.buckets);

  const budget = request.maxRecords ?? 20_000;
  const head = await store.audit.headSeq(request.tenant);
  if (!head.ok) return head;

  const counts = new Map<string, Map<bigint, number>>();
  let scanned = 0;
  let truncated = false;

  // Walk backwards a page at a time until the records predate the window.
  let upper = head.value;
  while (upper >= 0) {
    if (scanned >= budget) {
      truncated = true;
      break;
    }
    const size = Math.min(SERIES_PAGE, budget - scanned, upper + 1);
    const from = upper - size + 1;
    const page = await store.audit.range(request.tenant, from, size);
    if (!page.ok) return page;
    if (page.value.length === 0) break;

    let reachedOlder = false;
    for (const record of page.value) {
      scanned += 1;
      const tick = tickOf(record);
      if (tick === undefined) continue;
      if (tick < oldestStart) {
        reachedOlder = true;
        continue;
      }
      if (tick >= openStart) continue; // still-filling bucket
      const start = (tick / width) * width;
      const byBucket = counts.get(record.kind) ?? new Map<bigint, number>();
      byBucket.set(start, (byBucket.get(start) ?? 0) + 1);
      counts.set(record.kind, byBucket);
    }

    if (reachedOlder) break;
    upper = from - 1;
  }

  const wanted = request.kinds === undefined ? [...counts.keys()].sort(compareKeys) : [...request.kinds];
  const series = wanted.map((kind) => {
    const byBucket = counts.get(kind) ?? new Map<bigint, number>();
    const buckets: Bucket[] = [];
    for (let i = request.buckets; i >= 1; i -= 1) {
      const start = openStart - width * BigInt(i);
      buckets.push({ startTick: start, count: byBucket.get(start) ?? 0, closed: true });
    }
    return { key: kind, buckets };
  });

  return ok({ series, scanned, truncated, fromTick: oldestStart });
}

function tickOf(record: AuditRecord): bigint | undefined {
  // `at` is an opaque tick token written by whichever chronology was in force.
  // A record whose `at` is not an integer tick simply does not contribute,
  // rather than being counted into an arbitrary bucket.
  try {
    return BigInt(record.at);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Integer statistics
 * ------------------------------------------------------------------ */

/** Median of a count series. Integer; ties round down. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return Math.floor(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

/**
 * Median absolute deviation.
 *
 * Used instead of a standard deviation because incentive traffic is spiky and
 * a single flash sale in the baseline inflates a standard deviation enough to
 * hide the next real incident. MAD ignores the outlier it is measuring against.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const centre = median(values);
  return median(values.map((value) => Math.abs(value - centre)));
}
