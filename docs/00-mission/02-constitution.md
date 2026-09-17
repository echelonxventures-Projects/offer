# The constitution

Nine laws. Each one is enforced by a test, and the test is named so you can find
it. If a law breaks, the fix is the code, not the test.

---

## Law 1 — The engines know nothing about domains

No engine may branch on whether something is a coupon, a cashback scheme, a
subsidy or a commission. Domain names appear in exactly three places: the
`domain-profile` registry, the profile builders, and prose.

**Why.** The moment an engine contains `if (profile === "coupon")`, every new
domain is an engine change, and the sixty-seventh domain is a rewrite.

**Enforced by** `test/platform.test.ts` → *"no engine mentions a domain word
outside a comment"*, which greps every file in `src/engines` for the words
`coupon`, `cashback`, `voucher`, `affiliate`, `subsidy` and friends with
comments stripped.

---

## Law 2 — Anything that varies is a registry entry

Currencies, calendars, places, benefit types, effects, operators, funding
models, objectives, policies, risk signals, attribution models and context
resolvers are all data. Adding one is a `register()` call.

**Why.** It is the only mechanism that scales to "any industry, any
jurisdiction" without a fork per tenant.

**Enforced by** `test/platform.test.ts` → *"a brand-new benefit type works with
no change to any engine"*, which registers a carbon-credit rebate that nothing
in `src` anticipated and asserts it computes and is granted correctly; plus the
sibling tests for a new operator, a new unit and a new calendar.

---

## Law 3 — Money is exact

All amounts are integer counts of minor units in `bigint`, with the scale
carried on the amount. No floating point touches a monetary value anywhere.
Every operation that could lose value takes an explicit rounding mode.

**Why.** `0.1 + 0.2 !== 0.3`. A platform that computes liabilities cannot be
approximately right.

**Enforced by** `test/amount.test.ts`, particularly *"never creates or destroys
value"*, which splits many amounts many ways and asserts the parts sum exactly
to the whole every time.

---

## Law 4 — Every decision explains itself

A decision carries the checks it ran, whether each passed, what values were
compared, why each rejected offer was rejected, and why each eligible offer was
displaced.

**Why.** "Why didn't I get the discount?" is the most frequent question this
platform will ever be asked. An answer that requires reading server logs is not
an answer.

**Enforced by** `test/decision.test.ts` → *"reports every check it ran, not just
the failure"* and *"the best compatible subset wins and the losers say why"*.

---

## Law 5 — A decision is not an execution

Deciding changes nothing. Reserving consumes limits and holds budget. Capturing
posts to the ledger. The three are separate calls with separate names.

**Why.** A price is quoted many times and taken once. Conflating the two either
over-consumes limits on every page view, or under-consumes them and oversells.

**Enforced by** `test/execution.test.ts` → *"reserve holds budget and writes
nothing to the ledger"* and *"capture converts the hold into spend"*.

---

## Law 6 — The books balance or the write is refused

Every ledger transaction nets to zero within every unit. An unbalanced
transaction is rejected at the boundary rather than stored.

**Why.** A rounding bug in a benefit handler becomes a hole in the accounts, and
it is found months later by someone who cannot trace it.

**Enforced by** `test/settlement.test.ts` → *"an unbalanced transaction is
rejected, naming the unit"* and *"units must balance independently of one
another"*; and end-to-end by *"reversal posts contra entries and leaves the
ledger net zero"*.

---

## Law 7 — Time and place have no defaults

Nothing calls `Date.now()`. Nothing assumes a year, a month, a week, a
time zone, a country or a latitude. Instants come from an injected clock;
calendars publish named fields; places are nodes in a tree.

**Why.** It is what makes replay possible, and what makes the platform work for
a fiscal calendar, a lunar colony and a game world without special cases.

**Enforced by** `test/temporal.test.ts` (a Martian calendar publishing `sol`
rather than `month`, and a cross-frame comparison being refused) and
`test/spatial.test.ts`; plus `test/platform.test.ts` → *"the kernel knows
nothing about money, time or place either"*.

---

## Law 8 — Context is frozen once resolved

A resolved context is deep-frozen before any engine sees it. Two engines reading
the same context see identical bytes.

**Why.** A decision that cannot be replayed byte-for-byte cannot be audited, and
an engine that mutates shared context creates bugs that only appear under load.

**Enforced by** `test/platform.test.ts` → *"a resolved context cannot be mutated
by an engine"*.

---

## Law 9 — Doing nothing never wins a tie

When a combination of offers ties on score with applying nothing, the offers
win. An offer that grants points or entitlements scores zero in the interaction's
unit and must not therefore lose to the empty set.

**Why.** This was a real bug, found by the test in Law 2. A customer promised
points would not have received them, and the decision would have looked correct.

**Enforced by** `test/platform.test.ts` → *"a brand-new benefit type works with
no change to any engine"*, and implemented in `betterTieBreak` in
`src/engines/stacking.ts`.

---

## How to add a law

A law earns its place when it has been broken once. Each of these is either a
structural commitment that the rest of the design depends on, or the fossil of
a specific bug. Laws 9 and 10-in-waiting came from failing tests during
development, not from planning.

Adding one means: write the test first, watch it fail, fix the code, then write
the law down here with a pointer to the test.
