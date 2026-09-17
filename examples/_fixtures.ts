/**
 * Draft fixtures shared by the examples, so each example shows the interesting
 * part rather than fifty lines of setup.
 */
import type { ValueExchangeDraft } from "../src/model/value-exchange.ts";
import * as profiles from "../src/profiles/builders.ts";
import { gte, money, path } from "../src/rules/ast.ts";

export function promotionDraft(): ValueExchangeDraft {
  return {
    profile: "promotion",
    name: "10% off electronics",
    description: "Automatic, no code, sequential.",
    visibility: "public",
    acquisition: { mode: "automatic" },
    benefits: [
      {
        id: "discount",
        type: "percentage",
        params: { rate: "10" },
        effect: "price_reduction",
        target: { categories: ["electronics"] },
      },
    ],
    funding: { model: "single", splits: [{ sourceId: "merchant-acme" }] },
    limits: {},
    stacking: { groups: ["price"], application: "sequential" },
    priority: 100,
    governance: { owner: "campaigns@demo" },
    metadata: {},
  };
}

export function cashback(): ValueExchangeDraft {
  return profiles.cashback({
    name: "Northern Bank 5% back",
    description: "Bank-funded cashback, credited after 30 days.",
    percent: "5",
    cap: "3000.00",
    maturityDays: 30,
    parallel: true,
    priority: 50,
    owner: "partnerships@demo",
    funding: { model: "single", splits: [{ sourceId: "bank-northern" }] },
    conditions: gte(path("cart.subtotal"), money("INR", "1000.00")),
    limits: { maxPerRedemption: { unit: "INR", decimal: "3000.00" } },
  });
}

/** The plainest possible offer: 10% off, one merchant funder. */
export function simpleOffer(name: string): ValueExchangeDraft {
  return {
    profile: "promotion",
    name,
    visibility: "public",
    acquisition: { mode: "automatic" },
    benefits: [{ id: "d", type: "percentage", params: { rate: "10" }, effect: "price_reduction" }],
    funding: { model: "single", splits: [{ sourceId: "merchant-acme" }] },
    limits: {},
    stacking: { application: "sequential" },
    priority: 0,
    governance: { owner: "ops@demo" },
    metadata: {},
  };
}
