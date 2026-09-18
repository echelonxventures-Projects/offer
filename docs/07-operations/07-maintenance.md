# Maintenance

Everything that must run periodically, and what happens if it does not.

```ts
// Whatever schedules things in your deployment calls this.
const now = platform.temporal.now();
await platform.maintenance.runDue("acme", now.value);
```

The runner does not own a timer. It is given "now" and decides what is due, so
cron, `setInterval`, a Kubernetes CronJob and a Lambda schedule all work without
the platform having an opinion. See
[ADR 0014](../06-adr/0014-observability-as-ports-not-vendors.md).

---

## The jobs

Run in `order`, not alphabetically — the sweep must precede the health check or
health reports reservations that are about to be released.

| Order | Job | Every | If it never runs |
| --: | --- | --- | --- |
| 10 | `reservations.sweep` | 5 min | **Budget leaks permanently.** Abandoned checkouts hold it forever, and a campaign with money left starts refusing customers. |
| 20 | `audit.checkpoint` | 1 hr | Verification stays O(all of history) and gets slower forever. |
| 30 | `audit.anchor` | 1 hr | A wholesale rewrite of the chain becomes undetectable. |
| 40 | `audit.reconcile` | 1 hr | You have anchors but never compare them, which is the same as not having them. |
| 90 | `health.check` | 1 min | Nothing notices an unbalanced ledger or a broken chain. |

`audit.anchor` and `audit.reconcile` are **optional**: with no anchor configured
they report `skipped`, not `failed`. Not anchoring is a deployment choice, not
an incident — though an unwise one.

## Reading the report

```ts
{
  tenant, at,
  jobs: [{ job, status: "ran" | "skipped" | "failed" | "not_due", summary, durationMs, data }],
  ran, failed,
  health: HealthReport,
  alerts: AlertFiring[],
}
```

Health is recomputed *after* every job, so the report reflects the state the
pass left behind rather than the state it found. Alerts are evaluated last, for
the same reason.

## Intervals are enforced here, not by the caller

Call `runDue` as often as you like — every ten seconds is fine. Jobs that are
not due report `not_due` and cost nothing. That means the host's schedule does
not have to match the jobs' schedules, which is what makes a single generic
"run maintenance" trigger workable.

`runAll` forces every job regardless, for an operator who wants a pass now.

## The multi-process caveat

Last-run times are held **in process**. Two instances each run every job.

Both the sweep and the checkpoint are idempotent, so duplicate runs are wasteful
rather than dangerous — a second sweep finds nothing, a second checkpoint
verifies zero new records. But wasteful is still wrong at scale.

Three ways out, in increasing order of effort:

1. **Run maintenance on one instance.** A separate deployment with one replica,
   or a leader-election sidecar. Simplest, and correct.
2. **Take a lease.** A row with a holder and an expiry, acquired before the
   pass. About thirty lines against the existing store.
3. **Trigger from a scheduler that already guarantees single execution** — a
   Kubernetes CronJob with `concurrencyPolicy: Forbid`, or a queue with a
   deduplication window.

This is listed in [known gaps](../08-roadmap/02-known-gaps.md) rather than
pretended away.

## Adding a job

```ts
platform.maintenance.jobs.register({
  key: "acme.expire-grants",
  label: "Expire grants past their expiry date",
  order: 15,
  intervalSeconds: 3600,
  async run({ tenant, now }) {
    // ...
    return ok({ summary: `expired ${count} grant(s)`, data: { count } });
  },
});
```

Two rules for job authors:

- **Be idempotent.** A job may run twice; it must not do damage twice.
- **Be bounded.** Take a `limit` and leave the rest for the next pass. An
  unbounded job on a bad day becomes an outage.

## What to alert on

Not the jobs themselves — the *consequences*. `report.alerts` already carries
them, each with a runbook link. The one job-level signal worth watching is
`failed > 0` over several consecutive passes: a single failure is usually a
race, a persistent one is not.
