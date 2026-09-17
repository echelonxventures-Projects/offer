# Attribution Engine

`src/attribution/attribution.ts`

Who gets the credit when a value exchange is redeemed.

## Touchpoints and journeys

Touchpoints are recorded as they happen:

```ts
caps.track({
  tenant, kind: "click",
  party: { kind: "affiliate", id: "dealsite" },
  subjectId, valueExchangeId, channel: "web",
});
```

Kinds: `view`, `click`, `share`, `referral`, `assist`, `conversion`.

A journey is the touchpoints for a subject or device, oldest first, filtered by
the lookback window.

Identity resolution is deliberately simple: a touchpoint matches on `subjectId`
**or** `deviceId`, so pre-login activity attaches to a subject once they
identify. Anything more sophisticated is a tenant's own identity graph, resolved
upstream.

## Models

| Model | Divides credit |
| --- | --- |
| `last_touch` | All to the final touchpoint |
| `first_touch` | All to the first |
| `linear` | Equally |
| `position_based` | 40% first, 40% last, 20% among the middle |
| `time_decay` | Halving backwards through the journey |

Attribution is a commercial argument, not a technical fact, so the model is a
registry entry and every partner in the chain can be shown a different one.

## Exactness

Credit is divided with the same remainder-preserving allocator used for money.
Basis points always sum to exactly 10 000; money always sums to exactly the
value attributed.

```
linear over three touchpoints:
  basis points   3334 + 3333 + 3333 = 10000
  money          333.34 + 333.33 + 333.33 = 1000.00
```

`test/attribution.test.ts` asserts this for every model at journey lengths 1, 2,
3, 5 and 7. An attribution report whose columns do not add up is the fastest way
to lose a partner's trust, and rounding is where that happens.

Note that percentages *displayed* to one decimal may show 33.3 × 3 = 99.9. The
basis points are exact; the display is rounded. `examples/04-affiliate-settlement.ts`
prints both so the distinction is visible.

## Relationship to commission

They are separate on purpose:

- The **commission** is a benefit with the `commission` effect. It decides *how
  much* is owed and posts it to a payable account.
- **Attribution** decides *who* it is owed to.

A commission can be posted to a single payee immediately and attributed later,
which is what most affiliate programmes actually do — pay the network, let the
network divide it.

## Storage

In memory, in a `Map`. Correct and fully tested, but not durable. A real
deployment needs an adapter, and it is listed in
[known gaps](../08-roadmap/02-known-gaps.md).
