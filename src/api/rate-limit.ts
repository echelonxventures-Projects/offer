/**
 * Rate limiting.
 *
 * A port and a token-bucket reference implementation. No Redis, no vendor.
 *
 * Two layers, because they defend against different things:
 *
 *   - Per principal, per capability. Stops a misbehaving integration.
 *   - Per source, pre-authentication. Stops credential and coupon-code
 *     brute-forcing, which by definition has no principal yet.
 *
 * The second is the one that matters for this platform specifically: codes are
 * short, and without a limit the platform will faithfully validate every guess.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { RegistryEntry, Registry } from "../registry/registry.ts";
import { Registry as RegistryClass } from "../registry/registry.ts";

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests left in the current window. */
  readonly remaining: number;
  /** Milliseconds until the bucket has room again. Zero when allowed. */
  readonly retryAfterMs: number;
  readonly policy: string;
}

export interface RateLimiter {
  /** Consume one unit against a key. Never throws; a limiter outage allows. */
  consume(key: string, policy: RateLimitPolicy, nowMs: number): RateLimitDecision;
}

export interface RateLimitPolicy extends RegistryEntry {
  /** Sustained rate. */
  readonly perSecond: number;
  /** Burst capacity. A bucket this size refills at `perSecond`. */
  readonly burst: number;
  /** Capabilities this applies to. Empty means it is the default. */
  readonly capabilities?: readonly string[];
}

export const DEFAULT_RATE_POLICIES: RateLimitPolicy[] = [
  {
    key: "default",
    label: "Default",
    description: "Everything without a more specific policy.",
    perSecond: 50,
    burst: 100,
  },
  {
    key: "read",
    label: "Read-heavy surfaces",
    description: "Quotes and discovery. Generous: these are pure and cheap.",
    perSecond: 200,
    burst: 400,
    capabilities: ["apply", "optimize", "discover", "search", "compare", "forecast", "simulate", "validate"],
  },
  {
    key: "financial",
    label: "Value-committing",
    description:
      "Reserve, redeem, fund, pay. Tight on purpose: a runaway loop here does not waste CPU, it moves money.",
    perSecond: 20,
    burst: 40,
    capabilities: ["reserve", "redeem", "release", "reverse", "fund", "pay", "settle"],
  },
  {
    key: "authoring",
    label: "Authoring and governance",
    description: "Human-paced by nature.",
    perSecond: 5,
    burst: 20,
    capabilities: ["create", "clone", "publish", "govern", "issue", "activate"],
  },
  {
    key: "unauthenticated",
    label: "Pre-authentication",
    description:
      "Applied per source before credentials are checked. This is the coupon and credential brute-force defence.",
    perSecond: 5,
    burst: 20,
  },
];

export function rateLimitPolicyRegistry(): Registry<RateLimitPolicy> {
  return new RegistryClass<RateLimitPolicy>("rate-limit-policy").registerAll(DEFAULT_RATE_POLICIES);
}

/** The policy governing a capability: the most specific match, else default. */
export function policyFor(policies: Registry<RateLimitPolicy>, capability: string): RateLimitPolicy {
  for (const policy of policies.list()) {
    if (policy.capabilities?.includes(capability)) return policy;
  }
  return policies.get("default") ?? (DEFAULT_RATE_POLICIES[0] as RateLimitPolicy);
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * In-memory token bucket.
 *
 * Correct for one process. A multi-process deployment needs a shared counter,
 * or each instance enforces the limit independently and the effective rate is
 * the limit times the instance count. Stated here rather than discovered.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxKeys: number;

  constructor(options: { maxKeys?: number } = {}) {
    // An unbounded map keyed by caller-supplied strings is itself a denial of
    // service. Oldest keys are evicted; an evicted key simply starts full.
    this.#maxKeys = options.maxKeys ?? 100_000;
  }

  consume(key: string, policy: RateLimitPolicy, nowMs: number): RateLimitDecision {
    const bucket = this.#buckets.get(key) ?? { tokens: policy.burst, lastRefillMs: nowMs };

    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(policy.burst, bucket.tokens + (elapsedMs / 1000) * policy.perSecond);
    bucket.lastRefillMs = nowMs;

    let decision: RateLimitDecision;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      decision = { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0, policy: policy.key };
    } else {
      const deficit = 1 - bucket.tokens;
      decision = {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.ceil((deficit / policy.perSecond) * 1000),
        policy: policy.key,
      };
    }

    if (!this.#buckets.has(key) && this.#buckets.size >= this.#maxKeys) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest !== undefined) this.#buckets.delete(oldest);
    }
    this.#buckets.set(key, bucket);
    return decision;
  }

  reset(): void {
    this.#buckets.clear();
  }
}

/** A limiter that allows everything. The default, so limiting is opt-in. */
export const unlimited: RateLimiter = {
  consume: (_key, policy) => ({ allowed: true, remaining: policy.burst, retryAfterMs: 0, policy: policy.key }),
};

export function rateLimited(decision: RateLimitDecision): Result<never> {
  return fail(ErrorCode.LIMIT_EXCEEDED, `rate limit '${decision.policy}' exceeded`, {
    policy: decision.policy,
    retryAfterMs: decision.retryAfterMs,
  }) as Result<never>;
}

export { ok };
