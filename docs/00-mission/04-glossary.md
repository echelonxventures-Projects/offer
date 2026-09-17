# Glossary

Defined once, used consistently everywhere. Where a term is deliberately *not*
used, that is noted too.

## Core

**Value exchange** — the single record this platform stores. Any incentive,
offer, benefit, subsidy, commission or entitlement is one. Abbreviated `vx` in
identifiers. See [the data model](../01-architecture/05-data-model.md).

**Profile** — a label on a value exchange (`coupon`, `cashback`,
`government_benefit`). Used for presentation, reporting and policy selection.
Never for control flow. See [profiles](../02-domains/02-profiles.md).

**Subject** — whoever the exchange is evaluated for: a customer, a household, a
corporate account, a device. Not "user", because a subject is frequently not a
person.

**Grant** — an instance of a value exchange held by a specific subject: an
issued code, an allocated entitlement. Has its own lifecycle and use count.

**Context** — the complete, frozen set of facts a decision is made against.
Structural core (reality, tenant, instant, place, unit, subject, cart) plus open
registry-declared facets.

**Decision** — what *would* happen. Advisory, commits nothing, hashable.

**Execution** — what *did* happen. Two-phase: reserved, then captured.

## Money

**Economic unit** — anything value can be denominated in. USD is one. So are
loyalty points, carbon kilograms and entitlement seats. There is no "currency"
type in this platform.

**Amount** — an exact integer count of minor units, plus the unit key and its
scale. `{ unit: "USD", minor: 1234n, scale: 2 }` is $12.34.

**Minor units** — the smallest representable division. Cents for USD, whole
points for POINTS, thousandths for BHD.

**Scale** — decimal places. Carried on every amount so it is self-describing.

**Rate** — an exact rational (`{ numerator, denominator }`). Percentages,
exchange rates and splits are all rates. Never a float.

**Allocation** — dividing an amount into parts that sum exactly back to the
whole, with rounding remainders distributed deterministically.

## Benefits

**Benefit type** — *how much* value: `percentage`, `flat`, `tiered`, `volume`,
`fixed_price`, `free_quantity`, `item_grant`, `points_accrual`.

**Effect kind** — *what the value does*: reduces the price now, creates a
deferred credit, grants points, waives a fee, owes a commission.

The split matters: a discount and a cashback share a benefit type and differ
only in effect. See [ADR 0001](../06-adr/0001-one-record-for-every-domain.md).

**Unit policy** — whether a benefit type computes in the interaction's unit
(`base`) or mints value in its own declared unit (`declared`).

**Target** — which cart lines a benefit applies to.

**Base** — the amount a benefit computes against, after targeting and after any
earlier sequential benefits.

## Stacking

**Stacking group** — exchanges in the same group compete; the best one wins.

**Exclusive** — an exchange that, if applied, excludes everything else.

**Sequential application** — computes against what is left after earlier
benefits. The default, and correct for discounts.

**Parallel application** — computes against the original base. Correct for
cashback and commissions, which should not shrink because a discount ran first.

**Objective** — what "best" means when combinations compete. A registry entry.

**Displaced** — an exchange that was eligible but did not make the winning
combination, with the reason recorded.

## Funding and ledger

**Funding source** — a budget held by a party, in one unit, with reserved and
spent tracked separately.

**Funding model** — how a benefit's cost divides: `proportional` or `waterfall`.

**Reserved** — committed but not captured. Released if the interaction is
abandoned.

**Spent** — captured. Posted to the ledger.

**Double entry** — every movement is two or more ledger entries netting to zero
within each unit.

**Clearing account** — where price reductions land pending merchant settlement.

**Liability** — what the platform owes a subject: wallet balances, cashback
awaiting maturity, points.

**Payable** — what the platform owes a third party: commissions.

**Reconciliation** — netting the ledger into per-account positions.

## Time and place

**Instant** — a tick count against a chronology. Not a `Date`.

**Chronology** — tick size and epoch. `earth.unix.ms`, `mars.sol.msd`.

**Frame** — a reference timeline. Instants are comparable only within a frame.
Mars sols share Earth's SI-second frame; a relativistic vessel clock does not.

**Calendar** — decomposes an instant into named integer fields. Gregorian
publishes `year/month/day/dayOfWeek`; the Martian one publishes `sol/millisol`.
Rules reference fields by name and do not know which calendar produced them.

**Temporal window** — a from/to range plus optional calendar-field constraints.

**Spatial node** — a place in a containment tree. Physical or virtual.

**Jurisdiction** — the governance authority effective at a node. Deliberately
separate from containment, because an embassy sits inside one place and under
another's law.

**Spatial scope** — include and exclude lists. Exclude always wins.

## Platform

**Registry** — the extension mechanism. A named, enumerable, sealable map of
entries.

**Reality** — the outermost partition. Production is binding; sandbox and
simulation run the identical code path with effects detached.

**Capability** — one of the twenty-two public verbs. The entire external surface.

**Authority** — the object that owns a universal domain and answers every
question about it: `EconomicAuthority`, `TemporalAuthority`, `SpatialAuthority`.

**Trace** — the ordered record of what an engine did and why. Present on
contexts, rule evaluations, eligibility verdicts and decisions.

**Audit chain** — append-only, hash-linked records. Tamper-evident, not
tamper-proof. See [ADR 0009](../06-adr/0009-hash-chained-audit.md).

## Terms deliberately not used

**"Currency"** — too narrow; the platform handles points, resources and
entitlements identically. Use *economic unit*.

**"Coupon"** — a profile, not a concept the engines know. Use *value exchange*.

**"User"** — a subject is often an organisation or a device. Use *subject*.

**"Discount"** in engine code — it is a benefit type plus an effect. Naming it
"discount" would leak a domain assumption into the mechanism.
