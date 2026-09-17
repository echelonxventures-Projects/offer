# Errors

Every capability returns `Result<T, GoipError>`. Nothing throws for a business
outcome. See [ADR 0005](../06-adr/0005-results-not-exceptions.md) for why.

## The shape

```ts
{
  code: ErrorCode,
  message: string,               // human-readable, safe to log
  details?: Record<string, unknown>,  // machine-readable specifics
  retryable?: boolean,
}
```

`details` is where the useful part lives. An `UNKNOWN_REGISTRY_ENTRY` names the
registry, the missing key and what was available; an `INSUFFICIENT_FUNDS` names
the shortfall in minor units.

## The codes

| Code | Means | Caller should | HTTP |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | The request is malformed | Fix the request | 400 |
| `UNKNOWN_REGISTRY_ENTRY` | A referenced registry entry does not exist | Fix the key, or register it | 400 |
| `NOT_FOUND` | A referenced exchange, grant or account does not exist | Check the id | 404 |
| `FORBIDDEN` | Not permitted | Do not retry | 403 |
| `ILLEGAL_STATE` | Exists, but its state forbids this | Read the state and reconsider | 409 |
| `NOT_ELIGIBLE` | Conditions evaluated cleanly; the subject does not qualify | Show the reason | 200 |
| `RULE_ERROR` | A condition could not be evaluated | **Fix the rule** — this is an authoring bug | 500 |
| `INSUFFICIENT_FUNDS` | Funding cannot cover the benefit | Top up, or stop offering it | 409 |
| `UNIT_MISMATCH` | Two units cannot be combined and no rate exists | Fix the units or register a rate | 400 |
| `LIMIT_EXCEEDED` | An issuance or redemption limit is exhausted | Stop; the campaign is done | 409 |
| `CONFLICT` | Optimistic concurrency failure, or a broken audit chain | Retry, or **investigate** | 409 |
| `GOVERNANCE_REJECTED` | Policy or approval refused the action | Read `details.violations` | 422 |
| `RISK_BLOCKED` | Risk blocked the interaction | Offer an appeal path | 403 |
| `NOT_IMPLEMENTED` | Registered but unbound | Report it | 501 |

## The two that are not really errors

**`NOT_ELIGIBLE`** is an answer. It maps to 200 with the decision attached,
because the decision record carries the check list that explains it. Returning
a 4xx would push callers into treating a normal outcome as an exception.

**`RULE_ERROR`** is the opposite: it looks like a user error and is not. It
means someone authored a condition that cannot be evaluated — comparing a string
to money, calling an unregistered function, exceeding the node budget. It maps
to 500 because it is a bug in the tenant's configuration and should page
somebody, not be shown to a customer.

## `CONFLICT` deserves a second look

Two very different situations share this code:

- **Optimistic concurrency.** Retry.
- **A broken audit chain.** Do not retry. `verify()` returning `CONFLICT` means
  a stored audit record does not match its hash, and the `details.seq` says
  where. That is a security incident, not a transient failure. See
  [the runbook](../07-operations/06-runbook.md).

## Handling

```ts
const result = caps.redeem({ context, actor, idempotencyKey });

if (!result.ok) {
  switch (result.error.code) {
    case "INSUFFICIENT_FUNDS":
      return notifyCampaignOwner(result.error.details);
    case "LIMIT_EXCEEDED":
      return showCampaignEnded();
    case "RULE_ERROR":
      return pageOnCall(result.error);       // authoring bug
    default:
      return showGenericFailure(result.error.message);
  }
}

use(result.value);
```

## Errors versus panics

`GoipPanic` is thrown, and only for genuine programmer error: a negative scale,
division by zero, a sealed registry being written to. It is never thrown for
anything a caller could cause.

If you see a `GoipPanic` in production, it is a bug in the platform or in a
tenant-registered handler, and the stack trace is the right diagnostic.

## Writing errors in your own handlers

```ts
return fail(ErrorCode.INVALID_REQUEST, "tier thresholds must ascend", {
  benefit: spec.id,
  tiers: tiers.map((t) => t.min),
});
```

The message is for a human reading a log. The details are for code and for the
person debugging at 3am. Include the identifiers they will need to find the
record.
