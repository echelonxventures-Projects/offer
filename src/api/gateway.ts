/**
 * The gateway.
 *
 * Transport-neutral on purpose. `ApiRequest` is not an HTTP request, so the
 * same gateway runs under `node:http`, a queue consumer, a Lambda handler or a
 * test harness. The HTTP adapter in `http.ts` is about eighty lines on top.
 *
 * The order of operations is the security design, and each step is where it is
 * for a reason:
 *
 *   1. Pre-authentication rate limit, by source. Credential and coupon-code
 *      brute-forcing has no principal yet, so a per-principal limit cannot see
 *      it.
 *   2. Authenticate.
 *   3. Authorise: capability and tenant.
 *   4. Per-principal rate limit. After authentication, so one noisy integration
 *      cannot exhaust everybody else's budget.
 *   5. Override `actor` and `tenant` from the principal.
 *   6. Dispatch.
 *
 * Step 5 is the whole point. Until this existed, `actor` came out of the
 * request body and was believed.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { GoipError } from "../kernel/errors.ts";
import { encode } from "../kernel/codec.ts";
import type { Registry } from "../registry/registry.ts";
import type { Telemetry } from "../observability/telemetry.ts";
import { noopTelemetry } from "../observability/telemetry.ts";
import type { CapabilityDescriptor } from "../capabilities/descriptors.ts";
import type { Capabilities } from "../capabilities/capabilities.ts";
import type { Credentials, Principal } from "./principal.ts";
import type { Authenticator } from "./authentication.ts";
import type { Authorizer } from "./authorization.ts";
import type { RateLimiter, RateLimitPolicy } from "./rate-limit.ts";
import { policyFor, unlimited } from "./rate-limit.ts";
import { statusFor } from "./status.ts";

export interface ApiRequest {
  /** Capability key. The gateway refuses anything not in the registry. */
  readonly capability: string;
  /**
   * Tenant the caller is asking for.
   *
   * Optional, and usually better omitted: a principal scoped to exactly one
   * tenant has it resolved automatically, which means a single-tenant caller
   * cannot name the wrong tenant even by accident. Only a multi-tenant
   * principal has to be explicit.
   */
  readonly tenant?: string;
  /** Capability arguments. `actor` and `tenant` within it are ignored. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly credentials?: Credentials;
  /** Opaque origin for pre-authentication limiting: an IP, a connection id. */
  readonly source?: string;
  readonly correlationId?: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export interface GatewayOptions {
  readonly capabilities: Capabilities;
  readonly descriptors: Registry<CapabilityDescriptor>;
  readonly authenticators: Registry<Authenticator>;
  readonly authorizer: Authorizer;
  readonly rateLimiter?: RateLimiter;
  readonly ratePolicies: Registry<RateLimitPolicy>;
  readonly telemetry?: Telemetry;
  /** Wall-clock milliseconds, for rate limiting. Injected for tests. */
  readonly nowMs?: () => number;
}

export const GATEWAY_METRICS = {
  requests: "goip.api.requests",
  denied: "goip.api.denied",
  duration: "goip.api.duration",
} as const;

export class Gateway {
  readonly #options: GatewayOptions;
  readonly #telemetry: Telemetry;
  readonly #limiter: RateLimiter;
  readonly #nowMs: () => number;

  constructor(options: GatewayOptions) {
    this.#options = options;
    this.#telemetry = options.telemetry ?? noopTelemetry;
    this.#limiter = options.rateLimiter ?? unlimited;
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    const stop = this.#telemetry.timer(GATEWAY_METRICS.duration, { capability: request.capability });
    const outcome = await this.#dispatch(request);
    stop();

    if (!outcome.ok) {
      return this.#errorResponse(outcome.error, request);
    }
    this.#telemetry.count(GATEWAY_METRICS.requests, 1, { capability: request.capability });
    return {
      status: 200,
      body: outcome.value,
      headers: { "content-type": "application/json" },
    };
  }

  async #dispatch(request: ApiRequest): Promise<Result<unknown>> {
    const descriptor = this.#options.descriptors.get(request.capability);
    if (!descriptor) {
      // Refused before authentication: an unknown capability tells an attacker
      // nothing, and doing the lookup first avoids the work.
      return fail(ErrorCode.NOT_FOUND, `no capability '${request.capability}'`, {
        capability: request.capability,
      });
    }

    /* 1. Pre-authentication limit, by source. */
    const preAuth = this.#options.ratePolicies.get("unauthenticated");
    if (preAuth && request.source) {
      const decision = this.#limiter.consume(`source:${request.source}`, preAuth, this.#nowMs());
      if (!decision.allowed) {
        this.#deny(request, "rate_pre_auth");
        return fail(ErrorCode.LIMIT_EXCEEDED, "too many requests from this source", {
          policy: decision.policy,
          retryAfterMs: decision.retryAfterMs,
        });
      }
    }

    /* 2. Authenticate. */
    const principal = await this.#authenticate(request.credentials);
    if (!principal.ok) {
      this.#deny(request, "authentication");
      return principal;
    }

    /* 3. Resolve the tenant, then authorise. */
    const tenant = resolveTenant(request.tenant, principal.value);
    if (!tenant.ok) {
      this.#deny(request, "tenant", principal.value);
      return tenant;
    }

    const authorized = this.#options.authorizer.authorize({
      principal: principal.value,
      capability: request.capability,
      tenant: tenant.value,
    });
    if (!authorized.ok) {
      this.#deny(request, "authorization", principal.value);
      return authorized;
    }

    /* 4. Per-principal limit. */
    const policy = policyFor(this.#options.ratePolicies, request.capability);
    const decision = this.#limiter.consume(
      `principal:${principal.value.id}:${policy.key}`,
      policy,
      this.#nowMs(),
    );
    if (!decision.allowed) {
      this.#deny(request, "rate_principal", principal.value);
      return fail(ErrorCode.LIMIT_EXCEEDED, `rate limit '${decision.policy}' exceeded`, {
        policy: decision.policy,
        retryAfterMs: decision.retryAfterMs,
      });
    }

    /* 5. Override identity, then dispatch. */
    return this.#invoke(descriptor, request, principal.value, tenant.value);
  }

  async #authenticate(credentials: Credentials | undefined): Promise<Result<Principal>> {
    if (!credentials || (!credentials.token && !credentials.scheme)) {
      return fail(ErrorCode.FORBIDDEN, "no credentials presented");
    }
    const scheme = credentials.scheme ?? "apikey";
    const authenticator = this.#options.authenticators
      .list()
      .find((candidate) => candidate.scheme === scheme);

    if (!authenticator) {
      return fail(ErrorCode.FORBIDDEN, `unsupported authentication scheme '${scheme}'`);
    }
    return authenticator.authenticate(credentials);
  }

  /**
   * Build the capability arguments.
   *
   * `actor` and `tenant` are taken from the authenticated principal and written
   * over whatever the body said. A caller cannot attribute an action to somebody
   * else, and cannot reach another tenant's data, whatever it sends.
   */
  async #invoke(
    descriptor: CapabilityDescriptor,
    request: ApiRequest,
    principal: Principal,
    tenant: string,
  ): Promise<Result<unknown>> {
    const payload: Record<string, unknown> = { ...request.payload };

    payload.actor = principal.id;
    payload.tenant = tenant;

    if (payload.context !== null && typeof payload.context === "object") {
      payload.context = {
        ...(payload.context as Record<string, unknown>),
        tenant,
        ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
      };
    }

    const method = (this.#options.capabilities as unknown as Record<string, unknown>)[descriptor.key];
    if (typeof method !== "function") {
      return fail(ErrorCode.NOT_IMPLEMENTED, `capability '${descriptor.key}' has no handler bound`);
    }

    const invoked = (method as (arg: unknown) => Promise<Result<unknown>>).call(
      this.#options.capabilities,
      payload,
    );
    return invoked;
  }

  #deny(request: ApiRequest, reason: string, principal?: Principal): void {
    this.#telemetry.count(GATEWAY_METRICS.denied, 1, {
      capability: request.capability,
      reason,
    });
    this.#telemetry.event({
      name: GATEWAY_METRICS.denied,
      severity: "warn",
      message: `'${request.capability}' denied: ${reason}`,
      labels: { capability: request.capability, reason },
      data: {
        ...(request.tenant === undefined ? {} : { tenant: request.tenant }),
        ...(principal === undefined ? {} : { principal: principal.id }),
        ...(request.source === undefined ? {} : { source: request.source }),
        // Credentials are never included, at any severity.
      },
    });
  }

  #errorResponse(error: GoipError, request: ApiRequest): ApiResponse {
    const status = statusFor(error.code);
    const headers: Record<string, string> = { "content-type": "application/json" };

    const retryAfterMs = error.details?.retryAfterMs;
    if (typeof retryAfterMs === "number") {
      headers["retry-after"] = String(Math.ceil(retryAfterMs / 1000));
    }

    return {
      status,
      headers,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
          ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
        },
      },
    };
  }
}

/**
 * Which tenant is this call for?
 *
 * An explicit tenant must be one the principal holds. An omitted one is
 * resolved when the principal is unambiguous, which is the common case and the
 * safer one: there is no field for a caller to get wrong.
 */
export function resolveTenant(requested: string | undefined, principal: Principal): Result<string> {
  const scoped = principal.tenants.filter((tenant) => tenant !== "*");

  if (requested !== undefined) {
    const permitted = principal.tenants.includes("*") || scoped.includes(requested);
    return permitted
      ? ok(requested)
      : fail(ErrorCode.FORBIDDEN, `principal '${principal.id}' may not act for tenant '${requested}'`, {
          principal: principal.id,
          tenant: requested,
        });
  }

  if (scoped.length === 1) return ok(scoped[0] as string);

  return fail(
    ErrorCode.INVALID_REQUEST,
    principal.tenants.includes("*")
      ? "this principal may act for any tenant, so the tenant must be stated"
      : `this principal holds ${scoped.length} tenants, so the tenant must be stated`,
    { principal: principal.id, tenants: scoped },
  );
}

/** Serialise a response body, preserving exact integers. */
export const serialise = (body: unknown): string => encode(body);

export { ok };
