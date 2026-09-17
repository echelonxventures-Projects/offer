# Security

What is protected, what is not, and what a deployment must add.

---

## What is not here

Stated first, because it matters most:

- **No authentication.** Capabilities take an `actor` string and trust it.
- **No authorisation.** Any caller may invoke any capability for any tenant.
- **No rate limiting.**
- **No encryption at rest or in transit** — there is no transport.
- **No PII handling policy.** `subject.attributes` accepts anything.

A deployment must put an authenticated, authorising, rate-limited gateway in
front of the capability layer. The capability descriptors give it something to
work with: `mutating` and `financial` classify which verbs need the strongest
controls, and the five financial ones are `fund`, `pay`, `redeem`, `reserve` and
`settle`.

---

## Threat model

| Threat | Control present | Gap |
| --- | --- | --- |
| Rule-authored DoS | No regex; depth and node budgets | Nothing bounds how many rules a tenant authors |
| Coupon brute-forcing | — | **Needs rate limiting at the gateway** |
| Over-redemption by racing | Two-phase execution | **Needs atomic counters in the adapter** |
| Budget exhaustion attack | Funding caps, limits | Depends on the above |
| Tampering with history | Hash-chained audit | Evidence only; needs external anchoring |
| Cross-tenant leakage | Tenant scoping on every store call | Not enforced by the type system |
| Privilege escalation in authoring | Separation-of-duties on approval | No identity to bind it to |
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

### 1. Authentication and authorisation

Bind `actor` to a verified identity. Then, at minimum:

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

### 2. Rate limiting

Per subject, per code, per IP. Coupon brute-forcing is the obvious attack: codes
are short and the platform will faithfully validate every attempt.

### 3. External anchoring of the audit head

Publish the head hash periodically to a store under **different credentials**.
Without it, an attacker with database access rewrites the chain consistently and
`verify()` passes. With it, the rewrite is detectable by comparison.

```
hourly: read head hash → append (tenant, seq, hash, timestamp) to the anchor store
audit:  compare the chain's head at seq N against the anchor's record for seq N
```

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
