# Mission

## The problem

Every organisation that sells anything eventually builds incentive software.
They start with a coupon table. Then marketing wants cashback, so a second
system appears with its own rules. Then the bank partner wants card-linked
offers, the loyalty programme wants points, the affiliate network wants
commissions, a regulator wants a subsidy scheme honoured at the till, and
finance wants to know why the promotional spend line is wrong.

Five years later there are seven systems. They disagree about who is eligible,
they cannot stack with each other, each has its own idea of what a discount
costs and who pays for it, and none of them can answer the two questions that
matter:

- **"Why didn't I get the discount?"** asked by a customer.
- **"Who paid for this, exactly?"** asked by finance.

The systems are different because the vocabularies are different. The underlying
mechanics are not different at all.

## The observation

A coupon and a government fuel subsidy are the same object.

Both say: *in this context, if these conditions hold, this subject receives this
benefit, funded by these parties, subject to these limits, recorded this way.*

They differ in how the subject acquires them, where they apply, who pays and
what the benefit does. Every one of those differences is **data**. None of them
is a difference in mechanism.

The same is true of cashback, gift cards, loyalty accruals, affiliate
commissions, employee benefits, referral bonuses, tier upgrades, free shipping,
and every construct in the specification's list of sixty-seven domains.

## The thesis

Build the mechanism once. Make everything that varies a registry entry.

```
CONTEXT → CONDITIONS → ELIGIBILITY → BENEFIT → EXECUTION → SETTLEMENT → AUDIT
```

That pipeline is invariant. What flows through it is configuration:

| What varies | How it is expressed |
| --- | --- |
| What counts as money | `economic-unit` registry entry |
| What counts as a date | `calendar` and `chronology` registry entries |
| What counts as a place | `spatial-node` registry entry |
| What a benefit computes | `benefit-type` registry entry |
| What that value does | `effect-kind` registry entry |
| What a condition can ask | `rule-operator` and `rule-function` entries |
| Who pays, and how it splits | `funding-model` entry plus funding sources |
| What "best offer" means | `decision-objective` entry |
| What must be approved | `policy` and `lifecycle-transition` entries |

Adding a domain means adding data. The engines never learn its name.

## What this buys

**One eligibility answer.** Every offer is evaluated by the same engine against
the same context, so two offers cannot disagree about whether a customer is a
new customer.

**One cost model.** Every benefit is funded by declared sources and posted to a
double-entry ledger, so the promotional spend line reconciles by construction
rather than by a nightly job that mostly works.

**One explanation.** Every decision carries the checks it ran, the values it
compared and the reasons it rejected what it rejected. Support can answer the
customer's question without reading logs.

**One audit trail.** Hash-chained records of every decision and every movement
of value, replayable because the clock is injected and the context is frozen.

**Genuine extensibility.** Not "extensible" as a brochure word — `npm test`
contains a test that registers a benefit type nobody anticipated, in a unit
nobody anticipated, and asserts it works with no engine change.

## What this is not

It is not a promise that nothing will ever need redesigning. That claim is not
available to anyone, and pretending otherwise would be the least trustworthy
thing this document could do. See [honest scope](03-honest-scope.md) for what
the architecture actually guarantees and where it will genuinely strain.

## Next

- [The constitution](02-constitution.md) — the laws, and the tests that hold the
  code to them.
- [Architecture overview](../01-architecture/01-overview.md) — how it is built.
