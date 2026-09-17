/**
 * Temporal windows.
 *
 * A window is "between these instants" plus optional constraints on named
 * calendar fields. "Weekends in Q4" is `{ from, to, constraints: [
 * {field:'dayOfWeek', in:[6,7]}, {field:'quarter', in:[4]} ] }` and it is the
 * same shape on Mars, where the fields happen to be `sol` and `millisol`.
 */
import type { Instant } from "./chronology.ts";

export interface FieldConstraint {
  /** Calendar field name. Validated against the calendar's `fieldNames`. */
  readonly field: string;
  /** Allowed values. */
  readonly in?: readonly number[];
  /** Forbidden values, applied after `in`. */
  readonly notIn?: readonly number[];
  /** Inclusive lower bound. */
  readonly min?: number;
  /** Inclusive upper bound. */
  readonly max?: number;
  /** Matches when `field % modulo === remainder`; every third sol, say. */
  readonly modulo?: number;
  readonly remainder?: number;
}

export interface TemporalWindow {
  /** Inclusive start. Absent means "since forever". */
  readonly from?: Instant;
  /** Exclusive end. Absent means "until further notice". */
  readonly to?: Instant;
  /** Calendar used to evaluate `constraints`. Required if any are present. */
  readonly calendar?: string;
  /** Zone key for field decomposition. Defaults to UTC. */
  readonly zone?: string;
  readonly constraints?: readonly FieldConstraint[];
}

export function constraintHolds(constraint: FieldConstraint, value: number | undefined): boolean {
  if (value === undefined) return false;
  if (constraint.in && !constraint.in.includes(value)) return false;
  if (constraint.notIn && constraint.notIn.includes(value)) return false;
  if (constraint.min !== undefined && value < constraint.min) return false;
  if (constraint.max !== undefined && value > constraint.max) return false;
  if (constraint.modulo !== undefined) {
    const remainder = constraint.remainder ?? 0;
    if (((value % constraint.modulo) + constraint.modulo) % constraint.modulo !== remainder) return false;
  }
  return true;
}
