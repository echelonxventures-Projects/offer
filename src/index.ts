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
export * from "./observability/telemetry.ts";
export * from "./observability/metrics.ts";
export * from "./observability/health.ts";
export * from "./observability/alerts.ts";
export * from "./operations/maintenance.ts";
export * from "./adapters/store.ts";
export * from "./adapters/memory-store.ts";
export * from "./profiles/index.ts";
export * from "./capabilities/index.ts";
export * from "./platform/index.ts";
