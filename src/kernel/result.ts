/**
 * Result type. Every capability returns one.
 *
 * Rationale: an offer that does not apply is not an exception, it is an answer,
 * and it must carry its reasoning with it. Exceptions lose that reasoning.
 */
import type { GoipError } from "./errors.ts";
import { ErrorCode, goipError } from "./errors.ts";

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = GoipError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E = GoipError>(error: E): Err<E> => ({ ok: false, error });

export const fail = (
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Err<GoipError> => err(goipError(code, message, details));

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

export function map<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

export function flatMap<T, U, E>(r: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  return r.ok ? f(r.value) : r;
}

/** Unwrap or throw. Only for tests and examples, never for library code. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap() on Err: ${JSON.stringify(r.error)}`);
}

/**
 * Collect a list of results into a result of a list, failing on the first Err.
 *
 * Named `allOk` rather than `all` because `all` is a rule-DSL builder in
 * `src/rules/ast.ts`, and the package re-exports both from its root.
 */
export function allOk<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
}
