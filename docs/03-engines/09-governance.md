# Governance Engine

`src/engines/governance.ts`

Checks on a value exchange **as authored**, before it may go live. Not on the
traffic it later sees.

## Why authoring-time

Most damage in this domain is done at authoring time: a campaign with no funder,
an offer with no end date, a discount an order of magnitude larger than
intended. By the time traffic arrives it is too late — money has moved.

## Shipped policies

| Policy | Severity | Checks |
| --- | --- | --- |
| `funding.declared` | error | At least one funding source |
| `funding.sources_exist` | error | Every named source exists |
| `benefit.types_registered` | error | Every benefit type and effect is registered |
| `commission.payable_unit` | error | A commission is in a transferable unit |
| `window.valid` | error | Window constraints name fields the calendar publishes |
| `budget.bounded` | warning | A budget, redemption cap, or capped funder exists |
| `public.has_window` | warning | A public offer has an end date |
| `owner.named` | warning | An accountable human is recorded |

`error` blocks publication. `warning` is reported and does not.

Two of these are worth their place on their own:

**`commission.payable_unit`** — a commission credited in loyalty points can
never actually be paid out. It would sit as an un-settleable liability until
somebody noticed, probably during an audit.

**`budget.bounded`** — an offer with no budget, no redemption cap and an
uncapped funder is unbounded exposure. It is a warning rather than an error
because there are legitimate cases, and a platform that blocks them would be
worked around.

## Lifecycle

```
draft ──► in_review ──► approved ──► scheduled ──► active
  │           │            │                         │
  │           ▼            ▼                      ┌──┴──┐
  └───────► archived ◄─────┘                      ▼     ▼
                                              paused  exhausted
                                                 │       │
                                                 └───────┴──► archived
                                                    active ──► expired
```

The transition table is a registry, so an edge can be made to require approval
per deployment without a code change.

Only `active` is redeemable.

## Approval

`in_review → approved` requires a recorded approval **from someone other than
the author**. Self-approval is refused, and the message says why:

```
'in_review' to 'approved' needs an approval from someone other than the author
```

This is the cheapest possible separation of duties, and it is the one control
that would have prevented most of the incident reports in this domain.

Policy review runs again on every move to `approved` or `active`, so an exchange
edited after approval is re-checked before it goes live.

## Using it

```ts
// Review without changing anything.
caps.validate({ tenant, valueExchangeId });
// → { passed, violations: [{ policy, severity, message, path }], policiesRun }

// Review and move.
caps.govern({ tenant, actor, valueExchangeId, to: "paused" });

// Review, approve, and walk to active in one call.
caps.publish({ tenant, actor, valueExchangeId, approvedBy: "finance@acme" });
```

`publish` takes the shortest legal route for the exchange's current state, so
callers do not encode the state machine themselves.

## Adding a policy

```ts
platform.governance.policies.register({
  key: "acme.max_discount",
  label: "No single offer may exceed 40%",
  severity: "error",
  profiles: ["coupon", "promotion"],   // omit for all
  check({ exchange, deps }) {
    // return PolicyViolation[]
  },
});
```

`profiles` is how a `requiredPolicies` entry on a domain profile gets enforced
for that family only.
