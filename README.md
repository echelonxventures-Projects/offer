# GOIP — Global Offer Infrastructure Platform

A universal value-exchange kernel. One record, one decision pipeline, and a
registry-driven extension model that lets a coupon, a cashback scheme, a
government subsidy, an affiliate commission and a loyalty accrual run through
identical code.

```
CONTEXT → CONDITIONS → ELIGIBILITY → BENEFIT → EXECUTION → SETTLEMENT → AUDIT
```

- **Zero dependencies at runtime.** Pure TypeScript, executed natively by Node.
- **Zero build step.** `node examples/01-coupon.ts` runs the real platform.
- **Durable and atomic.** SQLite adapter on Node's built-in driver; limits and
  budgets are enforced inside the write, proven by concurrency tests.
- **Language-agnostic contract.** 289 conformance vectors, with an independent
  **Go** implementation that reproduces every one of them.
- **Exact money.** Integer minor units and `bigint` throughout. No floats, ever.
- **Explainable.** Every decision carries the full trace of why it went that way.
- **Auditable.** Hash-chained records; tampering is detectable and located.

---

## Quick start

```bash
node --version          # needs >= 22.6 (tested on 26)
npm test                # 200 tests, no install required
npm run demo            # all six worked examples
npm run example:coupon  # one of them
```

There is nothing to install to run the platform. `npm install` only fetches
TypeScript, which is needed for `npm run typecheck` and for nothing else.

## The shortest possible example

```ts
import { GoipPlatform } from "./src/platform/platform.ts";

const platform = new GoipPlatform();
const caps = platform.capabilities;

caps.fund({
  tenant: "acme", actor: "ops", sourceId: "merchant-1", label: "Promo budget",
  party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "10000.00",
});

const offer = caps.create({
  tenant: "acme", actor: "ops",
  draft: {
    profile: "promotion",
    name: "10% off",
    benefits: [{ id: "d", type: "percentage", params: { rate: "10" }, effect: "price_reduction" }],
    funding: { model: "single", splits: [{ sourceId: "merchant-1" }] },
    governance: { owner: "ops@acme.example" },
  },
});

caps.publish({ tenant: "acme", actor: "ops", valueExchangeId: offer.value.id, approvedBy: "finance@acme.example" });

const quote = caps.apply({
  context: {
    tenant: "acme", unit: "USD",
    cart: { lines: [{ id: "l1", sku: "WIDGET", quantity: 1, unitPrice: { unit: "USD", minor: 5000n, scale: 2 }, categories: [] }] },
  },
});
// quote.value.decision.payableReduction -> 5.00 USD
```

## What is actually here

| Area | What it does | Where |
| --- | --- | --- |
| Kernel | Results, errors, canonical hashing, wire codec, ids | `src/kernel` |
| Registry | The single extension mechanism | `src/registry` |
| Universal domains | Economic, temporal, spatial, reality | `src/universal` |
| Context | Assembling and freezing a decision context | `src/context` |
| Rules | Serialisable condition AST and evaluator | `src/rules` |
| Model | The `ValueExchange` record and its parts | `src/model` |
| Engines | Eligibility, benefit, stacking, decision, execution, governance, risk, discovery | `src/engines` |
| Ledger | Double-entry, funding allocation, settlement, payout | `src/ledger` |
| Attribution | Touchpoints and credit models | `src/attribution` |
| Audit | Hash-chained record of everything | `src/audit` |
| Capabilities | The 22-verb public surface | `src/capabilities` |
| Platform | Composition root | `src/platform` |
| Adapters | Storage ports, memory and SQLite implementations | `src/adapters` |

## Worked examples

Each is a runnable file that prints what it did and why.

| Example | What it demonstrates |
| --- | --- |
| `01-coupon.ts` | The full path: author → govern → quote → redeem → settle → audit |
| `02-cashback.ts` | Sequential vs parallel stacking, and why it matters to a customer |
| `03-government-subsidy.ts` | Issued grants, jurisdiction scoping, waterfall multi-party funding |
| `04-affiliate-settlement.ts` | Touchpoints, five attribution models, commission, payout |
| `05-off-world.ts` | A Martian calendar, Mars credits, and no engine changes |
| `06-stacking-conflict.ts` | Conflict groups, exclusivity, and objectives that disagree |
| `07-durability.ts` | Restart with nothing lost; 20 concurrent claims, 1 admitted |

## Two halves

| | |
| --- | --- |
| [`spec/`](spec/README.md) | The **specification** — vectors, schemas, encoding, storage contract. No TypeScript. |
| `src/` | The **reference implementation**, which happens to be TypeScript. |
| [`conformance/go/`](conformance/go) | An **independent Go implementation**, proving the spec is re-implementable. |

The split matters: an implementation has to be written in *some* language, so
what is portable is the contract. `spec/vectors/` freezes behaviour as input and
exact expected output, and the Go implementation reproduces all 289 cases with
no shared code.

```bash
npm run conformance     # reference + Go, against the same vectors
```

## Documentation

Start at **[docs/README.md](docs/README.md)**.

The three documents worth reading before anything else:

1. **[The constitution](docs/00-mission/02-constitution.md)** — the nine laws the
   code is held to, and the test that enforces each one.
2. **[Honest scope](docs/00-mission/03-honest-scope.md)** — what "no redesign,
   ever" can and cannot mean, stated plainly.
3. **[The decision pipeline](docs/01-architecture/03-decision-pipeline.md)** —
   how a request becomes a decision becomes money.

## Commands

| Command | Does |
| --- | --- |
| `npm test` | Run the test suite |
| `npm run demo` | Run all examples |
| `npm run typecheck` | Strict TypeScript check (needs `npm install`) |
| `npm run conformance` | Run the vectors against the reference and the Go implementation |
| `npm run vectors:generate` | Regenerate the conformance vectors |
| `npm run docs:registries` | Regenerate the registry reference from the code |
| `npm run docs:check` | Fail if the generated reference is stale |
| `npm run verify` | Typecheck, test, docs check, and examples together |

## Status

A complete, working reference implementation. **Phase 1 (durability) is done:**
storage is durable and atomic, with two adapters held to a shared conformance
suite and concurrency tests that include a negative control.

It has never carried production traffic. What is still missing is written down
rather than glossed over in
[docs/08-roadmap/02-known-gaps.md](docs/08-roadmap/02-known-gaps.md) — the
headline items now being **no authentication layer**, no PostgreSQL adapter, and
nothing scheduling the reservation reaper.

| | |
| --- | --- |
| Tests | 253, across 2 storage adapters |
| Conformance vectors | 289, across 2 language implementations |
| Typecheck | strict, clean |
| Runtime dependencies | 0 |
