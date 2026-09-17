# ADR 0009 — Hash-chained audit, not a blockchain

**Status:** Accepted · **Date:** 2026-09-17

## Context

This platform decides who gets public money, what a partner is owed and what a
customer was promised. Those decisions are disputed, sometimes years later,
sometimes by a regulator.

An audit log that can be edited without trace is not evidence.

## Decision

An append-only chain per tenant. Each record carries the hash of the previous
one:

```
hash = SHA-256(previousHash ‖ canonical(record))
```

`canonical()` sorts keys and spells bigints explicitly, so identical content
always produces identical bytes.

`verify()` recomputes the chain from genesis and reports the **sequence number**
where it first breaks.

## Consequences

**Good**

- Editing or deleting any past record invalidates every hash after it, and the
  verifier names where.
- No dependency. `node:crypto` and forty lines.
- Cheap: one SHA-256 per record.
- Combined with the injected clock and the frozen context, a disputed decision
  can be re-run and checked against its recorded hash.

**Bad**

- **Tamper evidence, not tamper proofing.** Anyone who can rewrite the whole
  chain can forge it consistently. Stated plainly in the module comment rather
  than implied away.
- `verify()` is O(n). Fine for thousands, not for a year of production. A real
  adapter needs periodic checkpoints.
- Serial by construction. Each record depends on the previous hash, so appends
  within a tenant cannot be parallelised — which is also why the chain is
  per-tenant rather than global.

## What this is not

**Not a blockchain.** No consensus, no distribution, no proof of work. Those
solve *"who do I trust to hold the log"*, which does not arise here: the tenant
holds their own log and the threat is a compromised insider or a bad migration,
not a Byzantine network.

**Not sufficient alone against an insider with database access.** For that,
anchor the head hash externally — publish it hourly to an append-only store
under different credentials, a partner's system, or a notarisation service.
Then a rewrite is detectable by comparing the head against the anchor.
[Security](../07-operations/03-security.md) covers this.

## Alternatives considered

**Plain append-only table with permissions.** Rejected: no evidence of
tampering, only a hope of prevention.

**Signed records.** Complementary, not alternative. Signing proves origin; the
chain proves ordering and completeness. A production deployment should do both.

**A blockchain.** Rejected: enormous operational cost for a trust problem that
does not exist in this deployment model.
