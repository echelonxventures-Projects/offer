/**
 * Error code to HTTP status.
 *
 * The mapping lives in `spec/errors.json`, which is the language-neutral
 * contract every implementation shares. This is the TypeScript view of it, and
 * `test/api.test.ts` asserts the two agree - so a status added in one place and
 * not the other fails the build rather than diverging quietly.
 */
import type { ErrorCode } from "../kernel/errors.ts";

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  INVALID_REQUEST: 400,
  UNKNOWN_REGISTRY_ENTRY: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  ILLEGAL_STATE: 409,
  NOT_ELIGIBLE: 200,
  RULE_ERROR: 500,
  INSUFFICIENT_FUNDS: 409,
  UNIT_MISMATCH: 400,
  LIMIT_EXCEEDED: 429,
  CONFLICT: 409,
  GOVERNANCE_REJECTED: 422,
  RISK_BLOCKED: 403,
  NOT_IMPLEMENTED: 501,
};

/**
 * `LIMIT_EXCEEDED` is 429 rather than the 409 the specification lists for the
 * *business* limit, because at the transport boundary it is overwhelmingly a
 * rate limit. The distinction is in `details.policy`: present means rate,
 * absent means a campaign limit. Callers that care should read it.
 */
export const statusFor = (code: ErrorCode): number => HTTP_STATUS[code] ?? 500;

/** Errors a caller may usefully retry without changing anything. */
export const isRetryable = (code: ErrorCode): boolean => code === "CONFLICT" || code === "LIMIT_EXCEEDED";
