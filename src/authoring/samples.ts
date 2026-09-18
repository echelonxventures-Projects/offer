/**
 * Sample contexts.
 *
 * Representative interactions a tenant validates offers against: a typical
 * basket, an anonymous visitor, a high-value order, an edge case somebody was
 * burned by once.
 *
 * They are a registry because "what does our traffic look like" is a tenant's
 * knowledge, not the platform's. The shipped set exists so preview works out of
 * the box and is deliberately generic; a real deployment replaces it with
 * samples drawn from its own traffic, which is the only way preview catches the
 * things that actually happen.
 */
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { ContextRequest } from "../context/context.ts";

export interface ContextSample extends RegistryEntry {
  /**
   * What this sample represents, in one line, for the preview report.
   * Distinct from `description`, which explains why the sample exists.
   */
  readonly summary: string;
  /**
   * The context, minus the tenant. Preview supplies that, so a sample is
   * portable between tenants and cannot accidentally name the wrong one.
   */
  readonly context: Omit<ContextRequest, "tenant">;
  /** Tags for selecting a subset: "anonymous", "high-value", "edge". */
  readonly tags?: readonly string[];
}

const usd = (minor: bigint) => ({ unit: "USD", minor, scale: 2 });

export const DEFAULT_CONTEXT_SAMPLES: ContextSample[] = [
  {
    key: "typical",
    label: "Typical basket",
    summary: "An identified returning customer, two lines, 100.00 USD",
    description: "The everyday case. If an offer does not behave here, it does not behave.",
    tags: ["core"],
    context: {
      unit: "USD",
      channel: "web",
      subject: { id: "sample-returning", segments: ["member"], counters: { "orders.lifetime": 5 } },
      cart: {
        lines: [
          { id: "l1", sku: "SAMPLE-A", quantity: 2, unitPrice: usd(3_000n), categories: ["general"], merchant: "sample-merchant" },
          { id: "l2", sku: "SAMPLE-B", quantity: 1, unitPrice: usd(4_000n), categories: ["general"], merchant: "sample-merchant" },
        ],
      },
    },
  },
  {
    key: "anonymous",
    label: "Anonymous visitor",
    summary: "No subject id, one line, 25.00 USD",
    description:
      "Catches conditions that assume an identified subject. A rule reading subject.tier on an anonymous visitor is a common authoring mistake.",
    tags: ["core", "anonymous"],
    context: {
      unit: "USD",
      channel: "web",
      cart: {
        lines: [{ id: "l1", sku: "SAMPLE-A", quantity: 1, unitPrice: usd(2_500n), categories: ["general"] }],
      },
    },
  },
  {
    key: "empty-cart",
    label: "No cart at all",
    summary: "A discovery call with no basket",
    description:
      "Discovery happens before a basket exists. An offer whose conditions require cart.subtotal will never be discoverable.",
    tags: ["core", "edge"],
    context: { unit: "USD", channel: "web", subject: { id: "sample-browsing" } },
  },
  {
    key: "high-value",
    label: "High-value order",
    summary: "An identified customer, 5,000.00 USD",
    description: "Finds uncapped percentage benefits before they find you.",
    tags: ["core", "high-value"],
    context: {
      unit: "USD",
      channel: "web",
      subject: { id: "sample-whale", segments: ["member"], counters: { "orders.lifetime": 40 } },
      cart: {
        lines: [{ id: "l1", sku: "SAMPLE-LUX", quantity: 1, unitPrice: usd(500_000n), categories: ["general"] }],
      },
    },
  },
  {
    key: "single-item",
    label: "Single cheap item",
    summary: "One line, 1.00 USD",
    description: "The floor. Catches flat discounts larger than the basket and minimum-spend gaps.",
    tags: ["core", "edge"],
    context: {
      unit: "USD",
      channel: "web",
      subject: { id: "sample-small" },
      cart: {
        lines: [{ id: "l1", sku: "SAMPLE-A", quantity: 1, unitPrice: usd(100n), categories: ["general"] }],
      },
    },
  },
];

export function contextSampleRegistry(): Registry<ContextSample> {
  return new Registry<ContextSample>("context-sample").registerAll(DEFAULT_CONTEXT_SAMPLES);
}
