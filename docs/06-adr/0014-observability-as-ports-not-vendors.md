# ADR 0014 — Observability as ports, not vendors

**Status:** Accepted · **Date:** 2026-09-18 · **Phase:** 2

## Context

Phase 2 needed metrics, health checks, alerting and scheduled maintenance. The
obvious path is an OpenTelemetry SDK, a Prometheus client, and a cron
dependency.

Every one of those would have undone what Phases 1 and 1b paid for. A platform
that claims to be agnostic of storage and language, and then hard-requires a
particular metrics vendor and a particular scheduler, is agnostic about the
things that were easy.

## Decision

Three ports, no vendors, no dependencies.

**Telemetry** is four methods — `count`, `observe`, `gauge`, `event` — plus a
`timer` convenience. `noopTelemetry` is the default, so instrumentation costs
nothing when nobody is collecting. `MemoryTelemetry` is the reference
collector; an adapter for any backend is a short file.

**Metric names are data.** `METRIC_DEFINITIONS` carries the name, kind, unit,
labels and a description of what each metric is *for*. An exporter is generated
from that list rather than hand-maintained, and `describeMetrics()` emits
exactly what a scrape-based system wants.

**Maintenance does not own a timer.** `MaintenanceRunner.runDue(tenant, now)` is
called by the host. cron, `setInterval`, a Kubernetes CronJob, a Lambda schedule
and a queue consumer are all the same thing from inside — "call this when due" —
and picking one would be the same mistake as picking a metrics vendor.

**Maintenance is not a capability.** The capability list is the platform's
contract with its callers and is closed at twenty-two. A sweep is something an
operator runs, not something a consumer invokes, so it lives on the platform
object.

## Consequences

**Good**

- Still zero runtime dependencies.
- A deployment wires one adapter and gets everything; a deployment that wires
  nothing pays nothing.
- `multiTelemetry` fans out, so collecting in memory for tests and shipping to a
  backend in production is one line.
- Alert rules are registry entries with a mandatory `runbook` field, so an alert
  without a defined response cannot be added.

**Bad**

- No distributed tracing. Spans need context propagation across async
  boundaries, which is a real feature and not four methods. `correlationId`
  threads through decisions and audit records and is the substitute.
- An exporter still has to be written per backend. The catalogue makes it
  mechanical, not free.
- `MemoryTelemetry` caps its sample buffers, so percentiles over very long
  windows are approximate. An unbounded buffer in a collector is how
  observability becomes the outage.

## Two bugs this phase produced, and what they changed

Both were found by writing `examples/08-operations.ts` and reading the output —
not by the unit tests, which happily asserted the wrong behaviour.

**Alerts latched.** Rules were written against cumulative counters, so one
funding refusal at 09:00 paged on every evaluation for the rest of the process's
life. Rules now ask `input.delta(metric)` — "what happened since I last looked" —
and `AlertEngine` keeps the baseline. Pinned by a test that evaluates three
times and asserts the quiet interval does not re-page.

**An alert paged with a healthy message.** The funding rule reused the health
check's `detail` string regardless of status, so it printed *"2 source(s), none
above 80%"* next to a PAGE. Paging with a reassuring message is worse than not
paging. The rule now uses the health detail only when health is what is wrong.

**Job order was alphabetical**, which put the health check before the sweep, so
it reported stale reservations that were about to be released — true when taken,
wrong by the time anyone read it. Jobs now carry an explicit `order`.

## Alternatives considered

**OpenTelemetry SDK.** Rejected: a large dependency tree and a vendor-shaped API
in the core. An OTel *adapter* over this port is the right place for it.

**Emit structured logs and let operators derive metrics.** Rejected: it pushes
aggregation onto every deployment and makes health checks impossible to express.

**A built-in scheduler.** Rejected: every serious deployment already has one,
and the platform's opinion about intervals would fight it.
