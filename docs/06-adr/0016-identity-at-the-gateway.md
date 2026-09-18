# ADR 0016 — Identity at the gateway, not in the capability

**Status:** Accepted · **Date:** 2026-09-18 · **Phase:** 3

## Context

Every capability took an `actor` string out of the request body and believed it.
This was the largest gap the platform had, and it was listed as such from Phase
0: anyone who could reach `redeem` could grant themselves benefits and attribute
them to somebody else.

The fix has an obvious wrong shape — add authentication to each capability —
and a less obvious right one.

## Decision

**A transport-neutral gateway in front of the closed capability surface**, doing
five things in a fixed order, and one of them is the whole point.

```
1. pre-authentication rate limit, by source
2. authenticate                  -> Principal
3. resolve tenant, authorise     -> capability + tenant
4. per-principal rate limit
5. OVERRIDE actor and tenant from the principal, then dispatch
```

Step 5 is the fix. The gateway writes `actor` and `tenant` over whatever the
body said, so a caller cannot attribute an action to somebody else or reach
another tenant's data, whatever it sends. The capabilities did not change.

Adding authentication *inside* each capability would have meant 22 places to get
it right and 22 places to forget it. The capability list is closed, so a single
choke point is complete by construction.

### Everything is a port

- **Authentication** — two stdlib implementations: API keys (stored hashed,
  compared in constant time) and HMAC bearer tokens. **Deliberately not JWT**:
  algorithm agility is JWT's most exploited feature — `alg: none` and RS/HS
  confusion are both live attacks — and this needs one algorithm, fixed. A
  deployment needing OIDC writes an adapter and owns that decision explicitly.
- **Authorisation** — roles are a registry. The shipped set is a starting point.
- **Rate limiting** — a port with an in-process token bucket. No Redis.
- **Transport** — `ApiRequest` is not an HTTP request, so the gateway runs under
  a queue consumer or a Lambda unchanged. The `node:http` adapter is ~80 lines,
  which is the evidence the gateway is genuinely neutral.

### Tenant is resolved, not stated

A principal scoped to one tenant has it resolved automatically. There is no
field for a single-tenant caller to get wrong. Only a multi-tenant principal
must be explicit.

## Consequences

**Good**

- The largest critical gap is closed, and `examples/09-api.ts` demonstrates it
  over a real socket: a claimed `ceo@acme.example` is recorded as
  `checkout-service`.
- Quoting and committing are different privileges. A compromised storefront key
  cannot grant anybody anything.
- Coupon and credential brute-forcing is bounded before authentication, which is
  the only place it can be bounded — there is no principal yet.
- OpenAPI is generated from the capability descriptors, so it cannot drift.

**Bad**

- `#invoke` dispatches by looking the capability name up on the facade, which is
  dynamic where the rest of the codebase is static. It is confined to one method
  and guarded by the descriptor registry, but it is a real seam.
- The in-process rate limiter is per-instance: the effective limit is the
  configured one times the instance count. A shared store is the fix, and the
  port is ready for it.
- Roles are coarse. There is no row-level authorisation — a principal that may
  `publish` may publish anything in its tenant.

## Two findings from building it

**The shipped `finance` role violated the platform's own separation check.** It
held both `fund` and `pay`, which is the classic collapsed duty: fund a budget,
then pay yourself out of it. `findSeparationOfDutiesIssues` flagged it before it
shipped, and it was split into `finance.funding` and `finance.treasury`. The
check exists because a role assembled from "capabilities somebody needed" drifts
into this without anyone deciding to.

**Audit records had the wrong actor.** They recorded the *subject* — the shopper
— as the actor of a capture. That conflates "who did this" with "who benefited",
which is precisely the distinction an investigation needs. The actor is now the
caller, and the subject is in the payload. The example surfaced it; the unit
tests had asserted around it.

## Alternatives considered

**Authentication middleware per capability.** Rejected: 22 places to forget.

**JWT.** Rejected on algorithm agility, as above. An adapter is welcome; a
default is not.

**Trust a mesh or gateway to inject identity headers.** Rejected as the *only*
mechanism: it works until one caller reaches the platform directly, and then it
has failed silently. A deployment with a trusted mesh can write an authenticator
that reads those headers, which makes the trust explicit.
