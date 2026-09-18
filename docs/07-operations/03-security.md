# Security

What is protected, what is not, and what a deployment must add.

---

## What is here now

Phase 3 closed the largest gap. There **is** an authenticated, authorising,
rate-limited gateway, and it is the only way to reach a capability over a
transport. See [running the API](08-api.md) and
[ADR 0016](../06-adr/0016-identity-at-the-gateway.md).

The single most important property: **the request body cannot name the actor.**
`actor` and `tenant` are overwritten from the authenticated principal before a
capability ever sees them, so a caller cannot attribute an action to somebody
else or reach another tenant's data.

## What is still not here

- **No encryption in transit.** The HTTP adapter is plain `node:http`. Terminate
  TLS in front of it, or wrap it.
- **No row-level authorisation.** A principal that may `publish` may publish
  anything in its tenant.
- **No key rotation workflow.** Issue and revoke exist; overlapping validity does
  not.
- **No mTLS or request signing.**
- **No PII handling policy.** `subject.attributes` accepts anything, and the
  guidance below is still guidance.

---

## Threat model

| Threat | Control present | Gap |
| --- | --- | --- |
| Rule-authored DoS | No regex; depth and node budgets | Nothing bounds how many rules a tenant authors |
| Coupon brute-forcing | Pre-authentication rate limit, per source | Per-instance; a shared store is needed at scale |
| Over-redemption by racing | Two-phase execution | **Needs atomic counters in the adapter** |
| Budget exhaustion attack | Funding caps, limits | Depends on the above |
| Tampering with history | Hash-chained audit | Evidence only; needs external anchoring |
| Cross-tenant leakage | Tenant taken from the principal, never the body | Not enforced by the type system below the gateway |
| Privilege escalation in authoring | Separation of duties at the door *and* in governance | Roles are coarse; no row-level rules |
| Malicious handler code | — | A registered handler runs in-process with full trust |

---

## Controls that are present

**Rule evaluation is total.** No regex (see
[ADR 0004](../06-adr/0004-no-regex-in-rules.md)), depth limit 32, node budget
5 000, no I/O. A tenant cannot author a rule that hangs a worker.

**Separation of duties on approval.** `in_review → approved` requires an
approval from someone other than the author. It is the single most valuable
control here, and the reason `approvedBy` is a distinct parameter.

**Tamper-evident audit.** Editing a record invalidates every hash after it and
`verify()` names the sequence number. See
[ADR 0009](../06-adr/0009-hash-chained-audit.md).

**Ledger balance enforcement.** An unbalanced transaction is refused at the
boundary, so a compromised or buggy handler cannot quietly create value.

**Non-transferable units cannot be paid out.** Enforced by the unit's class, so
it holds for units nobody has invented yet.

**Simulation cannot touch production.** `simulate` refuses a binding reality —
checked, not assumed.

---

## What a deployment must add

### 1. Authentication and authorisation — **now implemented**

The gateway binds `actor` to a verified identity and overrides the body. The
shipped roles map roughly onto the matrix below; audit your own with
`findSeparationOfDutiesIssues()`, which caught the shipped `finance` role
holding both `fund` and `pay` before it shipped.

| Capability group | Who |
| --- | --- |
| `create`, `clone`, `validate` | Campaign authors |
| `publish`, `govern` | Approvers — **never the same person as the author** |
| `fund` | Finance only |
| `pay` | Finance, with a second approval |
| `apply`, `discover`, `search` | Any authenticated caller |
| `reserve`, `redeem` | Trusted transaction services only |
| `audit`, `settle` | Auditors, read-only |

`redeem` deserves emphasis: a caller who can invoke it directly can grant
themselves benefits. It belongs behind a checkout service, not on a public API.

### 2. Rate limiting — **now implemented**

Two layers: per source before authentication (the brute-force defence, since
there is no principal yet) and per principal per capability after it.

The shipped limiter is in-process, so the effective limit is the configured one
times the instance count. Swap in a shared store; the port is one method.

### 3. External anchoring of the audit head — **now implemented**

Verification alone only proves the chain is *internally consistent*, which a
wholesale rewrite also is. An attacker with database access edits a record,
re-seals everything after it, and `verify()` passes.

Anchoring closes that. Publish the head hash to a store held under **different
credentials**, then compare.

```ts
const platform = new GoipPlatform({ anchor: new FileAuditAnchor(path, fs) });

await platform.auditService.anchor("acme");            // publish the head
await platform.auditService.reconcileWithAnchor("acme"); // compare
// CONFLICT: "audit record 41 does not match the anchor; the chain has been rewritten"
```

The `audit.anchor` and `audit.reconcile` maintenance jobs do both hourly.

**The port is deliberately tiny**, because a real anchor is somebody else's
system: an append-only bucket with a separate IAM role, a partner's service, a
notarisation provider. Two implementations ship:

| | Use | Protects against |
| --- | --- | --- |
| `MemoryAuditAnchor` | Tests | Nothing — it shares the process it anchors |
| `FileAuditAnchor` | Single host | The platform's own credentials, if the file is owned by another user and made append-only (`chattr +a`) |

Neither gives the credential separation that makes anchoring genuinely strong,
and both say so in their own documentation. Point it at a system you do not
control.

A test proves the property rather than asserting it: it forges a
self-consistent chain, confirms internal verification passes, and confirms the
anchor still catches it.

### 4. Tenant isolation

Every store call takes a tenant. Nothing in the type system prevents passing the
wrong one. Enforce it at the gateway by deriving the tenant from the
authenticated identity, never from the request body.

For stronger isolation, run a `GoipPlatform` per tenant — the composition root
makes this straightforward because nothing is a module-level singleton. See
[multi-tenancy](05-multi-tenancy.md).

### 5. Handler review

A registered benefit type, operator or resolver is arbitrary in-process code
with full trust. Treat registration as a code change: review it, version it,
deploy it. Do not build a UI that lets a tenant upload one.

---

## Data protection

`subject.attributes` and `facets` accept arbitrary JSON, and both end up in
decision traces and audit payloads.

**Do not put personal data there.** Put identifiers and derived facts:

| Instead of | Store |
| --- | --- |
| `dateOfBirth` | `ageBand: "25-34"` |
| `email` | `subject.id` |
| `address` | `spatial.place` |
| `cardNumber` | `binRange` or nothing |

Audit records are append-only and hash-chained, which means **you cannot delete
from them**. A right-to-erasure request against personal data in an audit
payload is unsatisfiable without breaking the chain. Keep the chain free of
personal data and erasure becomes a question about the subject store instead.
