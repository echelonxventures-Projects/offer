/**
 * The platform's single error vocabulary.
 *
 * Capability handlers never throw for expected outcomes; they return
 * `Result<T, GoipError>`. Thrown exceptions are reserved for programmer error
 * (a bug), which is precisely why `GoipError` is a plain object and not an
 * Error subclass: it is data, it serialises, it crosses the API boundary.
 */

export const ErrorCode = {
  /** The request itself is malformed. */
  INVALID_REQUEST: "INVALID_REQUEST",
  /** A referenced registry entry does not exist. */
  UNKNOWN_REGISTRY_ENTRY: "UNKNOWN_REGISTRY_ENTRY",
  /** A referenced value exchange, grant or account does not exist. */
  NOT_FOUND: "NOT_FOUND",
  /** The caller is not permitted to perform this capability. */
  FORBIDDEN: "FORBIDDEN",
  /** The value exchange exists but its lifecycle state forbids this action. */
  ILLEGAL_STATE: "ILLEGAL_STATE",
  /** Conditions evaluated cleanly and the subject is not eligible. */
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  /** A rule expression could not be evaluated. */
  RULE_ERROR: "RULE_ERROR",
  /** Funding could not cover the benefit. */
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  /** Two economic units cannot be combined and no exchange rate exists. */
  UNIT_MISMATCH: "UNIT_MISMATCH",
  /** A budget, issuance or redemption limit is exhausted. */
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  /** Optimistic concurrency failure; the caller should retry. */
  CONFLICT: "CONFLICT",
  /** Governance refused the action (policy, compliance, approval). */
  GOVERNANCE_REJECTED: "GOVERNANCE_REJECTED",
  /** Risk or fraud engine blocked the action. */
  RISK_BLOCKED: "RISK_BLOCKED",
  /** The capability is registered but has no handler bound. */
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface GoipError {
  readonly code: ErrorCode;
  readonly message: string;
  /** Machine-readable context: which rule, which unit, which limit. */
  readonly details?: Record<string, unknown>;
  /** True when an identical retry could plausibly succeed. */
  readonly retryable?: boolean;
}

export function goipError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  retryable = false,
): GoipError {
  return details === undefined
    ? { code, message, retryable }
    : { code, message, details, retryable };
}

/** Thrown only for genuine programmer error; never for a business outcome. */
export class GoipPanic extends Error {
  constructor(message: string) {
    super(`GOIP invariant violated: ${message}`);
    this.name = "GoipPanic";
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GoipPanic(message);
}
