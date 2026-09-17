/**
 * Kernel primitive types.
 *
 * Nothing in this file knows what a coupon, a currency, a country or a calendar
 * is. That ignorance is deliberate and is enforced by review: the kernel is the
 * one part of GOIP that must never need to change when a new domain arrives.
 */

/** Anything that can cross a process or storage boundary unchanged. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A plain record of JSON values. Used for open-ended attribute bags. */
export type JsonObject = { [key: string]: Json };

/**
 * Branded string. Gives us nominal typing over strings so a SpatialNodeId can
 * never be passed where an EconomicUnitId is expected, at zero runtime cost.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type TenantId = Brand<string, "TenantId">;
export type ActorId = Brand<string, "ActorId">;
export type SubjectId = Brand<string, "SubjectId">;
export type ValueExchangeId = Brand<string, "ValueExchangeId">;
export type GrantId = Brand<string, "GrantId">;
export type DecisionId = Brand<string, "DecisionId">;
export type ExecutionId = Brand<string, "ExecutionId">;
export type FundingSourceId = Brand<string, "FundingSourceId">;
export type AccountId = Brand<string, "AccountId">;
export type EntryId = Brand<string, "EntryId">;
export type RegistryKey = Brand<string, "RegistryKey">;
export type CorrelationId = Brand<string, "CorrelationId">;

/** Unsafe casts, confined to this module so the cast sites are greppable. */
export const asTenantId = (s: string): TenantId => s as TenantId;
export const asActorId = (s: string): ActorId => s as ActorId;
export const asSubjectId = (s: string): SubjectId => s as SubjectId;
export const asValueExchangeId = (s: string): ValueExchangeId => s as ValueExchangeId;
export const asRegistryKey = (s: string): RegistryKey => s as RegistryKey;
export const asFundingSourceId = (s: string): FundingSourceId => s as FundingSourceId;
export const asAccountId = (s: string): AccountId => s as AccountId;
export const asCorrelationId = (s: string): CorrelationId => s as CorrelationId;

/** Deep-readonly view of a value. Used for the resolved context. */
export type Immutable<T> = T extends (infer E)[]
  ? ReadonlyArray<Immutable<E>>
  : T extends object
    ? { readonly [K in keyof T]: Immutable<T[K]> }
    : T;

/** Recursively freeze an object graph. Cheap insurance for the context object. */
export function deepFreeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value as Immutable<T>;
}
