# Discovery Engine

`src/engines/discovery.ts`

"What can I get?" rather than "what do I get for this basket?"

## Same eligibility engine

Discovery calls straight into `EligibilityEngine`. There is deliberately no
separate "is it listable" path, because that path would drift from "is it
applicable" and produce the worst outcome in this domain: an offer displayed and
then refused at checkout.

## Standalone values

Each result reports what that exchange is worth **standing alone**, not as part
of a stack.

Showing a customer a combined total they will not receive — because the stack
conflicts once a real basket exists — is worse than showing less. So discovery
never stacks.

```ts
{
  valueExchangeId, profile, name, description?,
  eligible,
  indicativeValue?,     // present only when eligible
  primaryReason?,       // present when not
  verdict,              // the full check list
}
```

## Visibility

Private exchanges are excluded here, and **only** here. They still apply during
decisioning — an affiliate commission must work without ever being browsable.
See [ADR 0008](../06-adr/0008-visibility-is-not-applicability.md).

## Ranking

| Mode | Orders by |
| --- | --- |
| `value` (default) | Indicative value, then priority, then name |
| `priority` | The author's stated priority |
| `name` | Alphabetical |

In every mode, eligible results outrank ineligible ones. A customer should never
scroll past things they cannot have.

## Search

Case-insensitive substring over name and description. That is all.

It is enough for a catalogue of hundreds. A tenant with thousands should push an
index in front and pass the resulting ids as `candidateIds` — building a search
engine inside an incentive platform would be the wrong place for it, and it is
listed honestly in [known gaps](../08-roadmap/02-known-gaps.md).

## Including the ineligible

```ts
caps.discover({ context, includeIneligible: true });
```

Returns everything with the reasons attached. Two good uses:

- **"You're 200 away from free shipping."** Read `primaryReason` for
  `minimum_base` and turn it into a prompt.
- **Campaign debugging.** See exactly which check is stopping an offer for a
  given customer, without a support ticket.
