/**
 * GOIP - Global Offer Infrastructure Platform.
 *
 * Start with `GoipPlatform`, then go through `platform.capabilities`.
 * Everything else exported here exists so tenants can extend the registries.
 */
export * from "./kernel/index.ts";
export * from "./registry/registry.ts";
export * from "./universal/index.ts";
export * from "./context/index.ts";
export * from "./rules/index.ts";
export * from "./model/index.ts";
export * from "./engines/index.ts";
export * from "./ledger/index.ts";
export * from "./attribution/attribution.ts";
export * from "./audit/audit-log.ts";
export * from "./audit/anchor.ts";
export * from "./audit/audit-service.ts";
export * from "./audit/replay.ts";
export * from "./ledger/reconciliation.ts";
export * from "./ledger/positions.ts";
export * from "./platform/bundle.ts";
export * from "./authoring/preview.ts";
export * from "./authoring/samples.ts";
export * from "./authoring/explain.ts";
export * from "./authoring/diff.ts";
export * from "./observability/telemetry.ts";
export * from "./observability/metrics.ts";
export * from "./observability/health.ts";
export * from "./observability/alerts.ts";
export * from "./operations/maintenance.ts";
export * from "./kernel/order.ts";
export * from "./adapters/store.ts";
export * from "./adapters/memory-store.ts";
export * from "./profiles/index.ts";
export * from "./capabilities/index.ts";
export * from "./platform/config.ts";
export * from "./platform/index.ts";
export * from "./api/index.ts";
export * from "./intelligence/index.ts";
