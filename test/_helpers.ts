/**
 * Test fixtures. A fixed clock and sequential ids make every assertion in the
 * suite deterministic, including the audit hashes.
 *
 * Since Phase 1 the store ports are async, so the helpers are too. That is not
 * ceremony: it is what lets the same suite run unchanged against the SQLite
 * adapter, which is how the conformance tests work.
 */
import { GoipPlatform } from "../src/platform/platform.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { unwrap } from "../src/kernel/result.ts";
import type { ContextRequest } from "../src/context/context.ts";
import type { ValueExchange, ValueExchangeDraft } from "../src/model/value-exchange.ts";
import type { Amount } from "../src/universal/economic/amount.ts";
import type { PlatformStore } from "../src/adapters/store.ts";

/** Saturday, 19 September 2026, 10:30 UTC. */
export const TEST_MS = Date.UTC(2026, 8, 19, 10, 30, 0);
export const TENANT = "test";

export function platform(atMs = TEST_MS, store?: PlatformStore): GoipPlatform {
  return new GoipPlatform({
    clock: fixedClock(BigInt(atMs) * 1_000_000n),
    ids: sequentialIdFactory(),
    ...(store === undefined ? {} : { store }),
  });
}

/** A platform with one funded merchant, ready for a decision. */
export async function funded(atMs = TEST_MS, store?: PlatformStore): Promise<GoipPlatform> {
  const p = platform(atMs, store);
  unwrap(
    await p.capabilities.fund({
      tenant: TENANT,
      actor: "test",
      sourceId: "merchant-1",
      label: "Merchant budget",
      party: { kind: "merchant", id: "m1" },
      unit: "USD",
      budgetDecimal: "10000.00",
    }),
  );
  return p;
}

export async function publish(p: GoipPlatform, draft: ValueExchangeDraft): Promise<ValueExchange> {
  const created = unwrap(await p.capabilities.create({ tenant: TENANT, actor: "author", draft }));
  return unwrap(
    await p.capabilities.publish({
      tenant: TENANT,
      actor: "author",
      valueExchangeId: created.id,
      approvedBy: "approver",
    }),
  );
}

export const usd = (minor: bigint): Amount => ({ unit: "USD", minor, scale: 2 });

/** A basket of two lines totalling 100.00 USD. */
export function cartContext(over: Partial<ContextRequest> = {}): ContextRequest {
  return {
    tenant: TENANT,
    unit: "USD",
    place: "earth.us.ny",
    channel: "web",
    subject: { id: "s1", segments: ["member"], counters: { "orders.lifetime": 5 } },
    cart: {
      lines: [
        { id: "l1", sku: "WIDGET", quantity: 2, unitPrice: usd(3_000n), categories: ["tools"], merchant: "m1" },
        { id: "l2", sku: "GADGET", quantity: 1, unitPrice: usd(4_000n), categories: ["toys"], merchant: "m1" },
      ],
    },
    ...over,
  };
}

/** A minimal draft with one percentage discount. */
export function simpleDraft(over: Partial<ValueExchangeDraft> = {}): ValueExchangeDraft {
  return {
    profile: "promotion",
    name: "Test 10% off",
    visibility: "public",
    acquisition: { mode: "automatic" },
    benefits: [{ id: "d", type: "percentage", params: { rate: "10" }, effect: "price_reduction" }],
    funding: { model: "single", splits: [{ sourceId: "merchant-1" }] },
    limits: {},
    stacking: { application: "sequential" },
    priority: 0,
    governance: { owner: "test@example.com" },
    metadata: {},
    ...over,
  };
}

export { unwrap };
