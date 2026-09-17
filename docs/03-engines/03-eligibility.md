# Eligibility Engine

`src/engines/eligibility.ts`

Answers one question about one value exchange: may this apply, here, now, to
this subject?

## The ten checks

Ordered cheapest first.

| # | Check | Passes when |
| --: | --- | --- |
| 1 | `reality` | The exchange is scoped to this reality, or to none |
| 2 | `lifecycle` | State is `active` |
| 3 | `window` | The instant is inside the bounds and satisfies the field constraints |
| 4 | `spatial` | The context place sits inside the scope, and not inside an exclusion |
| 5 | `channel` | The context channel is listed, or no channels are listed |
| 6 | `merchant` | At least one cart line is from a listed merchant, or none are listed |
| 7 | `acquisition` | A code was presented, or a usable grant is held |
| 8 | `minimum_base` | The cart subtotal meets the minimum |
| 9 | `limit.*` | Issuance, redemption, per-subject, per-period and budget caps all have room |
| 10 | `conditions` | The rule AST evaluates true |

## Why it does not short-circuit

An exchange that fails on the window still reports what the channel, merchant
and limit checks would have said:

```ts
{
  eligible: false,
  primaryReason: "window: at or after window end",
  checks: [
    { check: "reality",       passed: true,  detail: "context reality 'production'" },
    { check: "lifecycle",     passed: true,  detail: "state 'active'" },
    { check: "window",        passed: false, detail: "at or after window end" },
    { check: "spatial",       passed: true,  detail: "matched earth.in" },
    { check: "channel",       passed: true,  detail: "all channels" },
    // ...
    { check: "conditions",    passed: false, skipped: true,
      detail: "not evaluated: an earlier check already failed" },
  ],
}
```

A merchant debugging a campaign sees the whole picture in one call rather than
fixing one problem, re-running, and finding the next.

## The one exception

Rule evaluation is the expensive step, so it is skipped once something
structural has failed — and the trace says so explicitly, with
`skipped: true`. Omitting it silently would be indistinguishable from it
having passed.

## Errors versus ineligibility

These are different and must stay different:

| Situation | Result |
| --- | --- |
| Conditions evaluate to `false` | `eligible: false` with the rule trace |
| Conditions *cannot* be evaluated | `RULE_ERROR` returned from the engine |

A rule comparing a string to money is an authoring bug. Reporting it as "not
eligible" would leave a broken campaign silently delivering nothing, which is
the failure mode this design exists to prevent.

## Acquisition in detail

| Mode | Check |
| --- | --- |
| `automatic` | Always passes |
| `code` + `shared` | One of `presentedCodes` matches `acquisition.code` |
| `code` + `unique` | A held grant's code matches a presented code |
| `issued` / `earned` / `referred` | An identified subject holds a grant with `uses < maxUses`, activated if required |

Codes are trimmed and upper-cased on both sides, so `" save10 "` matches
`SAVE10`. Asserted in `test/decision.test.ts`.

An anonymous subject cannot satisfy `issued`, `earned` or `referred`, and the
detail says so rather than reporting a generic failure.

## Limits

Read from `CounterStore`, never from the exchange record — which is what keeps
the record immutable between versions and cacheable.

| Limit | Counter |
| --- | --- |
| `totalIssuance` | `counters.issued` |
| `totalRedemptions` | `counters.redemptions` |
| `perSubject` | `counters.bySubject[subjectId]` |
| `perSubjectPerPeriod` | `counters.recentBySubject[subjectId]`, filtered by window |
| `totalBudget` | `counters.grantedByUnit[unit]` |

Limits are **checked** here and **consumed** at reserve. The gap between the two
is where over-redemption lives, and closing it is the reservation's job.

## Discovery uses the same engine

`DiscoveryEngine` calls straight into this one. There is no separate "is it
listable" path that could drift from "is it applicable".
