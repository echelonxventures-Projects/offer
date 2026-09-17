# Multi-tenancy

Three isolation models, from weakest to strongest. Pick per deployment, not per
tenant.

---

## Model 1 — Shared platform, tenant-scoped data

One `GoipPlatform`, one set of registries, every store call scoped by tenant.

```ts
const platform = new GoipPlatform();
caps.apply({ context: { tenant: "acme", ... } });
caps.apply({ context: { tenant: "globex", ... } });
```

| | |
| --- | --- |
| **Isolation** | Data only |
| **Registries** | Shared — every tenant sees the same units, calendars, benefit types |
| **Use when** | Tenants are homogeneous: same currencies, same calendars, same rules |
| **Risk** | A wrong `tenant` string leaks data. Nothing in the type system prevents it. |

**Mitigation:** derive the tenant from the authenticated identity at the
gateway, **never** from the request body.

Audit chains are already per-tenant in this model, so one tenant's history
cannot be read from another's chain.

---

## Model 2 — Shared platform, forked registries

Tenants share the engines but see different registry entries.

```ts
function tenantPlatform(tenant: string): GoipPlatform {
  const base = new GoipPlatform();

  const units = base.economic.units.fork(`units:${tenant}`);
  units.override({ key: "POINTS", label: "Acme Stars", scale: 0, unitClass: "points", fungible: true });
  units.register({ key: "ACME_CREDIT", label: "Acme credit", scale: 2, unitClass: "scrip", fungible: true });

  const calendars = base.temporal.calendars.fork(`calendars:${tenant}`);
  calendars.register(fiscalCalendar({ key: "fiscal.acme", label: "Acme FY", startMonth: 7 }));

  return new GoipPlatform({ /* wire the forked registries through */ });
}
```

`fork()` copies every entry into a non-strict child that may shadow any of them
without touching the parent.

| | |
| --- | --- |
| **Isolation** | Data and configuration |
| **Use when** | Tenants differ in units, calendars, policies or benefit types |
| **Cost** | One platform instance per tenant in memory; the engines are stateless so this is mostly registry copies |

This is the model most multi-tenant SaaS deployments want.

---

## Model 3 — Platform per tenant, separate process

Full isolation: separate process, separate store, separate audit chain.

| | |
| --- | --- |
| **Isolation** | Complete |
| **Use when** | Regulatory separation, a tenant requiring data residency, or one tenant's volume justifying its own capacity |
| **Cost** | Operational multiplicity |

Nothing in `src` is a module-level singleton, so this works without any change —
which is the practical payoff of the composition-root discipline.

---

## What is always per-tenant

Regardless of model:

| Thing | Scoping |
| --- | --- |
| Value exchanges | `(tenant, id)` |
| Grants | `(tenant, id)` |
| Counters | `(tenant, valueExchangeId)` |
| Executions | `(tenant, id)`, and `(tenant, idempotencyKey)` |
| Ledger entries | `tenant` on every row |
| **Audit chains** | One chain per tenant, independent genesis |

Funding sources are the exception: `MemoryFundingStore` keys them by id alone.
That is a **reference-adapter simplification**, and a real adapter must key them
by `(tenant, id)`. Noted in [known gaps](../08-roadmap/02-known-gaps.md).

---

## Realities and tenants are orthogonal

A tenant has several realities; a reality spans tenants.

```
                 production    sandbox    simulation
   acme              ✔            ✔            ✔
   globex            ✔            ✔            ✔
```

Scope an exchange to realities explicitly:

```ts
scope: { realities: ["sandbox"] }      // never applies in production
```

An exchange with no `realities` applies in all of them, which is the right
default for something authored once and promoted.

---

## Tenant onboarding checklist

1. Choose the isolation model, and apply it to the whole deployment.
2. Fork and extend registries if using model 2.
3. Create funding sources — **nothing can be published without one**.
4. Register tenant-specific policies (`acme.max_discount` and similar).
5. Register tenant-specific context resolvers.
6. Seal the registries.
7. Verify with `platform.describe()` that the tenant sees what you intended.
8. Author in `sandbox` first; promote by re-scoping.
