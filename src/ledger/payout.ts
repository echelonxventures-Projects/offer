/**
 * Payout and reconciliation.
 *
 * Reconciliation reads the ledger and answers "what is each account worth right
 * now". Payout turns a credit balance owed to a party into a movement off the
 * platform - and does so only for units that are actually transferable, which
 * is why loyalty points cannot accidentally be wired to a bank.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { IdFactory } from "../kernel/ids.ts";
import type { Amount } from "../universal/economic/amount.ts";
import type { EconomicAuthority } from "../universal/economic/authority.ts";
import type { LedgerEntry } from "./ledger.ts";
import { assertBalanced, signedMinor } from "./ledger.ts";

export type { AccountPosition } from "./positions.ts";
import type { AccountPosition } from "./positions.ts";

/** Net every account in the ledger, per unit. */
export function reconcile(entries: readonly LedgerEntry[]): AccountPosition[] {
  const positions = new Map<string, { accountId: string; unit: string; netMinor: bigint; entries: number }>();
  for (const entry of entries) {
    const key = `${entry.accountId}|${entry.amount.unit}`;
    const current = positions.get(key) ?? {
      accountId: entry.accountId,
      unit: entry.amount.unit,
      netMinor: 0n,
      entries: 0,
    };
    current.netMinor += signedMinor(entry);
    current.entries += 1;
    positions.set(key, current);
  }
  return [...positions.values()].sort(
    (a, b) => a.accountId.localeCompare(b.accountId) || a.unit.localeCompare(b.unit),
  );
}

/** The whole ledger must net to zero in every unit. If it does not, say so. */
export function verifyLedger(entries: readonly LedgerEntry[]): Result<{ units: string[]; entries: number }> {
  const perUnit = new Map<string, bigint>();
  for (const entry of entries) {
    perUnit.set(entry.amount.unit, (perUnit.get(entry.amount.unit) ?? 0n) + signedMinor(entry));
  }
  const broken = [...perUnit].filter(([, net]) => net !== 0n);
  if (broken.length > 0) {
    return fail(ErrorCode.CONFLICT, "ledger does not net to zero", {
      units: broken.map(([unit, net]) => ({ unit, net: net.toString() })),
    });
  }
  return ok({ units: [...perUnit.keys()].sort(), entries: entries.length });
}

export interface PayoutRequest {
  readonly tenant: string;
  readonly reality: string;
  /** Account holding the credit balance owed, e.g. a payable or a wallet. */
  readonly fromAccountId: string;
  /** Where the money is going; opaque to the platform. */
  readonly destination: { readonly kind: string; readonly reference: string };
  readonly amount: Amount;
  readonly at: string;
  readonly ids: IdFactory;
  readonly economic: EconomicAuthority;
  readonly memo?: string;
}

export interface Payout {
  readonly id: string;
  readonly tenant: string;
  readonly amount: Amount;
  readonly destination: { readonly kind: string; readonly reference: string };
  readonly entries: readonly LedgerEntry[];
  readonly at: string;
}

/**
 * Draw down a credit balance and move it to a clearing account for despatch.
 * The balance check happens against the supplied positions, so the caller
 * decides how fresh that view has to be.
 */
export function requestPayout(request: PayoutRequest, positions: readonly AccountPosition[]): Result<Payout> {
  const { tenant, reality, fromAccountId, amount, at, ids, economic } = request;

  if (amount.minor <= 0n) {
    return fail(ErrorCode.INVALID_REQUEST, "payout amount must be positive");
  }
  if (!economic.isTransferable(amount.unit)) {
    return fail(ErrorCode.INVALID_REQUEST, `unit '${amount.unit}' is not transferable and cannot be paid out`, {
      unit: amount.unit,
    });
  }

  const position = positions.find((p) => p.accountId === fromAccountId && p.unit === amount.unit);
  const available = position ? -position.netMinor : 0n; // credit balance is negative
  if (available < amount.minor) {
    return fail(ErrorCode.INSUFFICIENT_FUNDS, `account '${fromAccountId}' holds ${available}, payout needs ${amount.minor}`, {
      accountId: fromAccountId,
      availableMinor: available.toString(),
      requestedMinor: amount.minor.toString(),
    });
  }

  const payoutId = ids.next("pay");
  const transactionId = ids.next("txn");
  const reference = { kind: "payout", id: payoutId };
  const settlementAccount = `clr:${tenant}:payout:${amount.unit}`;

  const entries: LedgerEntry[] = [
    {
      id: ids.next("led"),
      tenant,
      reality,
      transactionId,
      accountId: fromAccountId,
      direction: "debit",
      amount,
      at,
      reference,
      memo: request.memo ?? `payout to ${request.destination.kind}`,
    },
    {
      id: ids.next("led"),
      tenant,
      reality,
      transactionId,
      accountId: settlementAccount,
      direction: "credit",
      amount,
      at,
      reference,
      memo: `awaiting despatch to ${request.destination.reference}`,
    },
  ];

  const balanced = assertBalanced(entries);
  if (!balanced.ok) return balanced;

  return ok({ id: payoutId, tenant, amount, destination: request.destination, entries, at });
}
