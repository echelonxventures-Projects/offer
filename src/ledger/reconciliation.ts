/**
 * Reconciliation.
 *
 * "What is each account worth" was answered by folding every entry the tenant
 * had ever written. That is correct and it never stops getting slower — and the
 * health check ran it every minute, so the check designed to catch problems was
 * on its way to becoming one.
 *
 * Same fix as the audit chain: a snapshot is a trusted starting point, and
 * reconciliation folds only what came after it. The snapshot is derived, never
 * authoritative — it can be deleted at any time and recomputed from the
 * entries, which is the property that makes it safe to cache a financial figure
 * at all.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { Instant } from "../universal/temporal/chronology.ts";
import type { LedgerSnapshot, PlatformStore } from "../adapters/store.ts";
import type { AccountPosition } from "./positions.ts";
import { signedMinor } from "./ledger.ts";
import type { LedgerEntry } from "./ledger.ts";
import { compareKeys } from "../kernel/order.ts";

/** Entries folded per round trip. Bounds memory regardless of ledger size. */
export const FOLD_BATCH = 5_000;

export interface PositionsResult {
  readonly positions: readonly AccountPosition[];
  /** Balances include every entry up to and including this sequence. */
  readonly throughSeq: number;
  /** Entries folded by this call, i.e. those written since the snapshot. */
  readonly foldedEntries: number;
  /** Where the fold started. -1 means it started from an empty ledger. */
  readonly fromSnapshotSeq: number;
}

export interface LedgerVerification {
  readonly balanced: boolean;
  readonly units: readonly string[];
  /** Per unit, the net that should be zero. Present only when it is not. */
  readonly imbalances?: readonly { readonly unit: string; readonly net: string }[];
  readonly throughSeq: number;
}

export class ReconciliationService {
  readonly #store: PlatformStore;
  readonly #batch: number;

  constructor(store: PlatformStore, batch: number = FOLD_BATCH) {
    this.#store = store;
    this.#batch = batch;
  }

  /** Current balances: the latest snapshot, plus everything written since. */
  async positions(tenant: string): Promise<Result<PositionsResult>> {
    const snapshot = await this.#store.ledger.latestSnapshot(tenant);
    if (!snapshot.ok) return snapshot;

    const running = new Map<string, { position: AccountPosition; net: bigint }>();
    for (const position of snapshot.value?.positions ?? []) {
      running.set(key(position.accountId, position.unit), { position, net: position.netMinor });
    }

    const fromSeq = snapshot.value?.throughSeq ?? -1;
    let cursor = fromSeq;
    let folded = 0;

    for (;;) {
      const page = await this.#store.ledger.entriesSince(tenant, cursor, this.#batch);
      if (!page.ok) return page;
      if (page.value.entries.length === 0) break;

      for (const entry of page.value.entries) fold(running, entry);
      folded += page.value.entries.length;
      cursor = page.value.lastSeq;

      // A short page means we reached the end; asking again would be a wasted
      // round trip on the hottest health-check path.
      if (page.value.entries.length < this.#batch) break;
    }

    const positions = [...running.values()]
      .map(({ position, net }) => ({ ...position, netMinor: net }))
      .sort((a, b) => compareKeys(a.accountId, b.accountId) || compareKeys(a.unit, b.unit));

    return ok({ positions, throughSeq: cursor, foldedEntries: folded, fromSnapshotSeq: fromSeq });
  }

  /**
   * Does the ledger net to zero in every unit?
   *
   * Derived from the positions, so it inherits the snapshot and does not
   * rescan. If this is ever false, stop: value has been created or destroyed.
   */
  async verify(tenant: string): Promise<Result<LedgerVerification>> {
    const current = await this.positions(tenant);
    if (!current.ok) return current;

    const perUnit = new Map<string, bigint>();
    for (const position of current.value.positions) {
      perUnit.set(position.unit, (perUnit.get(position.unit) ?? 0n) + position.netMinor);
    }

    const imbalances = [...perUnit]
      .filter(([, net]) => net !== 0n)
      .map(([unit, net]) => ({ unit, net: net.toString() }));

    return ok({
      balanced: imbalances.length === 0,
      units: [...perUnit.keys()].sort(),
      ...(imbalances.length === 0 ? {} : { imbalances }),
      throughSeq: current.value.throughSeq,
    });
  }

  /**
   * Compute and store a snapshot.
   *
   * Refuses to record one over an unbalanced ledger. A snapshot is a statement
   * that the balances up to this point are trusted, and trusting a hole makes
   * it permanent: every later reconciliation would inherit it without ever
   * rescanning the entries that would reveal it.
   */
  async snapshot(tenant: string, now: Instant): Promise<Result<LedgerSnapshot>> {
    const current = await this.positions(tenant);
    if (!current.ok) return current;

    if (current.value.throughSeq < 0) {
      return fail(ErrorCode.NOT_FOUND, `tenant '${tenant}' has no ledger entries to snapshot`, { tenant });
    }

    const perUnit = new Map<string, bigint>();
    for (const position of current.value.positions) {
      perUnit.set(position.unit, (perUnit.get(position.unit) ?? 0n) + position.netMinor);
    }
    const broken = [...perUnit].filter(([, net]) => net !== 0n);
    if (broken.length > 0) {
      return fail(ErrorCode.CONFLICT, "refusing to snapshot a ledger that does not net to zero", {
        tenant,
        units: broken.map(([unit, net]) => ({ unit, net: net.toString() })),
      });
    }

    const snapshot: LedgerSnapshot = {
      tenant,
      throughSeq: current.value.throughSeq,
      positions: current.value.positions,
      at: now.tick.toString(),
    };
    return this.#store.ledger.saveSnapshot(snapshot);
  }
}

const key = (accountId: string, unit: string): string => `${accountId}|${unit}`;

function fold(
  running: Map<string, { position: AccountPosition; net: bigint }>,
  entry: LedgerEntry,
): void {
  const k = key(entry.accountId, entry.amount.unit);
  const existing = running.get(k);

  if (existing) {
    existing.net += signedMinor(entry);
    existing.position = { ...existing.position, entries: existing.position.entries + 1 };
    return;
  }
  running.set(k, {
    position: { accountId: entry.accountId, unit: entry.amount.unit, netMinor: 0n, entries: 1 },
    net: signedMinor(entry),
  });
}
