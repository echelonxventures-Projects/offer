/**
 * The API layer.
 *
 * `createGateway` wires the pieces with sane defaults. Everything it assembles
 * is replaceable: a deployment with OIDC swaps the authenticator, one with a
 * shared rate-limit store swaps the limiter, one with its own role model swaps
 * the authorizer.
 */
import type { GoipPlatform } from "../platform/platform.ts";
import type { Telemetry } from "../observability/telemetry.ts";
import { capabilityRegistry } from "../capabilities/descriptors.ts";
import type { Authenticator } from "./authentication.ts";
import { authenticatorRegistry } from "./authentication.ts";
import type { Authorizer } from "./authorization.ts";
import { RoleAuthorizer, roleRegistry } from "./authorization.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { MemoryRateLimiter, rateLimitPolicyRegistry } from "./rate-limit.ts";
import { Gateway } from "./gateway.ts";

export * from "./principal.ts";
export * from "./authentication.ts";
export * from "./authorization.ts";
export * from "./rate-limit.ts";
export * from "./status.ts";
export * from "./gateway.ts";
export * from "./http.ts";
export * from "./openapi.ts";

export interface CreateGatewayOptions {
  /** Authenticators to accept. A gateway with none rejects every request. */
  readonly authenticators: readonly Authenticator[];
  readonly authorizer?: Authorizer;
  /** Defaults to an in-process token bucket. Swap for a shared one at scale. */
  readonly rateLimiter?: RateLimiter;
  readonly telemetry?: Telemetry;
  readonly nowMs?: () => number;
}

export function createGateway(platform: GoipPlatform, options: CreateGatewayOptions): Gateway {
  const authenticators = authenticatorRegistry().registerAll([...options.authenticators]);

  return new Gateway({
    capabilities: platform.capabilities,
    descriptors: capabilityRegistry(),
    authenticators,
    authorizer: options.authorizer ?? new RoleAuthorizer(roleRegistry()),
    rateLimiter: options.rateLimiter ?? new MemoryRateLimiter(),
    ratePolicies: rateLimitPolicyRegistry(),
    telemetry: options.telemetry ?? platform.telemetry,
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
}
