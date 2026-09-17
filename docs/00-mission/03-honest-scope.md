# Honest scope

The specification asks for a platform that works across "any industry, any
country, any planet, any civilisation, any reality model — without architectural
redesign."

This document says plainly which parts of that are achievable, which parts are
achieved here, and which parts are not available to anyone.

---

## The claim that cannot be met

**"No redesign, ever"** is not a property any architecture can have.

An architecture is a set of bets about what will vary and what will not. Good
bets buy you a decade. No bet survives a change to something the design treated
as fixed. If the underlying assumption changes — say, that a value exchange has
one subject, or that a decision is a pure function of its context — the design
changes, and no amount of indirection prevents that.

Claiming otherwise would mean the first genuinely novel requirement gets forced
through the existing abstractions, producing something worse than a redesign:
a design that no longer describes what the system does.

So this platform does not make that claim. It makes a narrower one that it can
actually keep.

## The claim that is met

**New value-exchange constructs are data, not code.**

Specifically, all of the following are registry entries and require no change to
any engine:

| Adding | Mechanism | Demonstrated in |
| --- | --- | --- |
| A currency, points scheme, resource or entitlement | `economic-unit` | `05-off-world.ts` (Mars credits, scale 4) |
| A calendar with its own fields | `calendar` | `05-off-world.ts` (sols, no months) |
| A place, physical or virtual | `spatial-node` | `05-off-world.ts` (Mars, Luna) |
| A way of computing benefit value | `benefit-type` | `test/platform.test.ts` (carbon rebate) |
| A thing a benefit does | `effect-kind` | Eight shipped, all used |
| A condition predicate | `rule-operator` | `test/platform.test.ts` (`acme.isLucky`) |
| A funding arrangement | `funding-model` | `03-government-subsidy.ts` (waterfall) |
| A definition of "best" | `decision-objective` | `06-stacking-conflict.ts` (four objectives) |
| A governance rule | `policy` | Eight shipped |
| An attribution model | `attribution-model` | `04-affiliate-settlement.ts` (five models) |
| A context fact | `context-resolver` or an open facet | `src/context/resolution-engine.ts` |

That list covers every axis of variation the specification actually enumerates.
"Any planet" is a spatial registry entry. "Any calendar" is a calendar registry
entry. "Any economic model" is an economic unit plus a funding model. These are
not rhetorical — there is a runnable example for each.

## Where it will genuinely strain

These are the load-bearing assumptions. Each is a real limit, stated so nobody
discovers it at the worst moment.

**One subject per decision.** The context has a single `subject`. A household
allowance shared by four people, or a corporate account where the buyer and the
beneficiary differ, is modelled by making the *account* the subject and carrying
the individual as an attribute. That works, but it is a workaround, and a true
multi-party entitlement would want a different context shape.

**Decisions are pure and synchronous.** An offer whose eligibility depends on a
live external call — a credit check, a real-time inventory lock — has to have
that answer resolved into the context first, by a resolver. That is the right
design for replayability, but it means the latency lands in context resolution
and the caller must know to ask for it.

**Stacking is a bounded search.** Optimal subset selection is NP-hard. Below ten
eligible offers the search is exhaustive and genuinely optimal; above it, a
greedy pass runs and the decision says `searchMode: "greedy"`. It does not
pretend the answer is optimal. See [ADR 0003](../06-adr/0003-bounded-stacking-search.md).

**Cross-unit comparison is refused, not solved.** A decision cannot rank an
offer giving 500 points against one giving $4 off without an exchange rate, and
importing a rate into a ranking makes the decision unexplainable. So ranking
counts only value in the interaction's own unit, and an offer denominated
elsewhere scores zero — it can still win, via Law 9, but it cannot be *compared*.
For most tenants this is correct. For a points-heavy programme it is a real
limitation.

**Time zones are fixed offsets.** The `temporal-zone` registry holds offsets,
not political daylight-saving rules. An offer that must end at "midnight local
time" across a DST boundary needs a zone-rule provider that is not shipped here.
This is called out in `src/universal/temporal/calendar.ts` rather than hidden.

**Cross-process contention is unproven.** The concurrency claims are tested
against genuine async interleaving and a real transactional database, but in one
process. Multi-process contention, replica lag and partitions need a networked
database to test honestly, and are listed as gaps rather than implied away.

## What is not built at all

To be unambiguous, these do not exist here:

- **Authentication and authorisation.** Capabilities take an `actor` string and
  trust it. There is no identity layer. This is now the largest single gap.
- **A networked database adapter.** Storage is durable (SQLite, via Node's
  built-in driver) and atomic, and the conformance suite is ready for a second
  implementation — but SQLite is single-writer, so a high-throughput
  multi-process deployment needs a PostgreSQL adapter that does not yet exist.
- **A scheduler.** `platform.reaper.sweep()` exists and is tested; nothing calls
  it on a timer.
- **Transport.** No HTTP server, no GraphQL schema, no Kafka producer. The
  capability layer is the surface those would wrap.
- **The intelligence fabric.** No machine-learned optimisation, forecasting or
  offer generation. `forecast` extrapolates linearly from observed spend and
  returns `null` rather than a confident number when there is no history.
- **Distribution.** No email, SMS or feed delivery.

## How to read the specification's ambitions

The specification lists sixty-seven domains, eighteen engines and twenty-six
benefit types. This implementation has one record, eleven engines, eight benefit
types and twenty-two capabilities.

That is not a shortfall. Most of the specification's list is the same mechanism
named repeatedly: "cashback" is a percentage with a deferred effect, "gift card"
is a flat amount with a wallet effect, "free shipping" is a flat amount with a
fee-waiver effect. Collapsing them is the design, and
[the domain catalog](../02-domains/01-domain-catalog.md) maps all sixty-seven to
where they live so the coverage can be checked rather than believed.
