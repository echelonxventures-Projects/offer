# ADR 0007 — Registry-driven time and space

**Status:** Accepted · **Date:** 2026-09-17

## Context

Incentive systems are saturated with temporal and spatial assumptions: a
`country` column, a `valid_from DATETIME`, "weekends" meaning Saturday and
Sunday, a seven-day week.

Each holds until it does not. A fiscal calendar starting in April. An Islamic
calendar where the month boundary is observational. A duty-free zone that is
inside a country for shipping and outside it for tax. A game world with no
geography at all. A lunar colony.

## Decision

Neither dimension has defaults.

**Time.** An `Instant` is a tick count against a `Chronology` (tick size, epoch,
reference frame). A `Calendar` decomposes an instant into **named integer
fields** and publishes which names it offers. Gregorian publishes
`year/month/day/dayOfWeek/quarter`; the Martian one publishes `sol/millisol`.

Rules reference fields by name:

```json
{ "op": "temporal.field", "field": "dayOfWeek", "in": [6, 7] }
{ "op": "temporal.field", "field": "fiscalQuarter", "in": [4] }
{ "op": "temporal.field", "field": "sol", "min": 0 }
```

The engine cannot tell which calendar produced the field.

**Space.** A `SpatialNode` is a node in a containment tree with a kind. There is
no country column, no latitude. Containment is the only question eligibility
asks, and a tree answers it in O(depth) with no geometry.

Jurisdiction is a **separate** attribute from containment, because they
genuinely diverge — an embassy sits inside one place and under another's law.

**Frames.** Instants are comparable only within a reference frame. Mars sols are
measured in SI seconds, so Mars shares Earth's frame and the two *are*
comparable. A relativistic vessel clock does not, and comparison is refused
rather than answered wrongly.

## Consequences

**Good**

- A fiscal calendar is a registry entry, and every rule reading `fiscalQuarter`
  starts working.
- A new planet is a spatial subtree. `examples/05-off-world.ts` adds two nodes
  and changes no engine.
- Virtual places (a marketplace surface, a game shard) sit in the same tree.
- Getting the frame boundary right means Earth and Mars instants are genuinely
  comparable, which a naive "Mars is different" split would have prevented.

**Bad**

- More ceremony. `temporal.now()` rather than `Date.now()`, everywhere.
- Conversion between chronologies with different tick sizes is lossy. Converting
  milliseconds to millisols floors, and round-tripping is not an identity. This
  is documented on the method and asserted with an explicit bound in
  `test/temporal.test.ts`.
- **Time zones are fixed offsets only.** No political daylight-saving rules. An
  offer ending at "local midnight" across a DST boundary needs a zone-rule
  provider that is not shipped. Called out in
  `src/universal/temporal/calendar.ts`.
- Authors must know which calendar their rule assumes.

## Alternatives considered

**`Date` plus an IANA time zone.** Rejected: bakes in the Gregorian calendar and
cannot express a fiscal or non-terrestrial one.

**A country/region/city schema.** Rejected: fails on the first duty-free zone,
and has nothing to say about virtual places.

**Latitude/longitude with geofences.** Rejected: geometry on the decision path is
expensive and hard to replay deterministically. Proximity, when needed, is
computed upstream and passed in as a context facet.
