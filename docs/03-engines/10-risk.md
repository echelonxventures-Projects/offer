# Risk Engine

`src/engines/risk.ts`

Scores a context, explains itself, and returns one of three dispositions.

## Scoring

Each signal returns 0–100 with a weight. The engine takes the **weighted mean**,
not the sum.

That choice matters: with a sum, adding a ninth signal inflates every score and
every threshold has to be retuned. With a mean, a signal can be added or removed
without disturbing the calibration.

```
score = Σ(signal.score × signal.weight) / Σ(signal.weight)
```

| Score | Disposition | Meaning |
| --- | --- | --- |
| < 50 | `allow` | Proceed |
| 50–79 | `review` | Proceed, flag for a human |
| ≥ 80 | `block` | Refuse with `RISK_BLOCKED` |

Thresholds are constructor parameters, not constants.

## Shipped signals

| Signal | Fires on |
| --- | --- |
| `velocity` | `subject.counters["redemptions.recent"]` at 3, 5 and 10 |
| `anonymous_high_value` | An anonymous subject with a large basket |
| `jurisdiction_mismatch` | Declared jurisdiction differs from the interaction's |
| `new_subject_large_benefit` | No prior orders |

These are starting points, deliberately simple. Real tuning is tenant-specific.

## Why it is this simple

A model that cannot say why it blocked a redemption cannot be appealed, and
every incentive platform eventually has to explain a block to a real customer
who did nothing wrong.

So the assessment always carries its reasoning:

```ts
{
  score: 62,
  disposition: "review",
  signals: [
    { signal: "velocity", score: 90, reason: "11 recent redemption(s)" },
    { signal: "new_subject_large_benefit", score: 30, reason: "first interaction for this subject" },
  ],
}
```

A tenant wanting a learned model registers it as one more signal:

```ts
platform.risk.signals.register({
  key: "acme.model_v3",
  label: "Gradient-boosted fraud model",
  weight: 3,
  evaluate({ context }) {
    const score = context.facets["mlRisk"];   // computed by a context resolver
    return ok({ score: typeof score === "number" ? score : 0, reason: "model v3" });
  },
});
```

The model's inference belongs in a **context resolver**, not in the signal —
signals must stay pure so the assessment is replayable. The signal reads the
facet the resolver produced.

## Where it is applied

Opt-in, per call:

```ts
caps.apply({ context, assessRisk: true });
```

Not automatic, because most traffic does not need it and the cost is real. A
deployment wanting it everywhere wraps the capability layer.

## What is not here

No device fingerprinting, no velocity storage of its own (it reads counters
another system populates), no graph-based ring detection, no case management.
The engine scores and explains; investigating is somebody else's product.
