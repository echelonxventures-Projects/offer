/**
 * Example 9 - the API, and what it refuses.
 *
 * A real HTTP server on node:http, with no framework. Every request below goes
 * over a socket.
 *
 * The important part is not that calls succeed. It is that the four things a
 * caller would previously have got away with are now refused, and that one of
 * them - naming yourself as somebody else - was possible until this layer
 * existed.
 */
import type { AddressInfo } from "node:net";
import { GoipPlatform } from "../src/platform/platform.ts";
import { MemoryApiKeyStore, apiKeyAuthenticator } from "../src/api/authentication.ts";
import { createGateway, createHttpServer, generateOpenApi } from "../src/api/index.ts";
import { roleRegistry, findSeparationOfDutiesIssues } from "../src/api/authorization.ts";
import { capabilityRegistry } from "../src/capabilities/descriptors.ts";
import { MemoryTelemetry } from "../src/observability/telemetry.ts";
import { encode } from "../src/kernel/codec.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { DEMO_INSTANT_MS, TENANT, heading, must, row, section } from "./_bootstrap.ts";
import { simpleOffer } from "./_fixtures.ts";

const telemetry = new MemoryTelemetry();
const platform = new GoipPlatform({
  clock: fixedClock(BigInt(DEMO_INSTANT_MS) * 1_000_000n),
  ids: sequentialIdFactory(),
  telemetry,
});

heading("EXAMPLE 9 - THE API: what it lets through, and what it does not");

/* ---------------------------------------------------------------- */
section("setup");

must(
  await platform.capabilities.fund({
    tenant: TENANT, actor: "ops", sourceId: "merchant-acme", label: "Acme budget",
    party: { kind: "merchant", id: "acme" }, unit: "USD", budgetDecimal: "5000.00",
  }),
  "fund",
);
const offer = must(
  await platform.capabilities.create({ tenant: TENANT, actor: "ops", draft: simpleOffer("Everyday 10% off") }),
  "create",
);
must(
  await platform.capabilities.publish({ tenant: TENANT, actor: "ops", valueExchangeId: offer.id, approvedBy: "finance" }),
  "publish",
);

const keys = new MemoryApiKeyStore();
const issue = (id: string, roles: string[]) => {
  const { secret } = keys.issue({ id, label: id, tenants: [TENANT], roles });
  return `${id}.${secret}`;
};

const storefrontKey = issue("storefront", ["commerce.surface"]);
const checkoutKey = issue("checkout-service", ["commerce.checkout"]);
row("keys issued", "storefront (quote only), checkout-service (may commit value)");
row("secrets stored", "hashed; the plaintext is returned once and never kept");

const gateway = createGateway(platform, {
  authenticators: [apiKeyAuthenticator({ store: keys })],
  telemetry,
});
const server = createHttpServer({ gateway, descriptors: capabilityRegistry() });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}/v1`;
row("listening", base);

const basket = {
  unit: "USD",
  channel: "web",
  subject: { id: "shopper-1" },
  cart: {
    lines: [
      { id: "l1", sku: "WIDGET", quantity: 1, unitPrice: { unit: "USD", minor: 10_000n, scale: 2 }, categories: ["tools"], merchant: "acme" },
    ],
  },
};

async function call(capability: string, key: string | null, payload: unknown) {
  const response = await fetch(`${base}/${capability}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { authorization: `ApiKey ${key}` }),
    },
    body: encode(payload),
  });
  // Loosely typed on purpose: this is a client, and a client sees JSON.
  return {
    status: response.status,
    body: (await response.json()) as {
      error?: { code?: string; message?: string };
      decision?: { payableReduction?: { minor?: string } };
    },
  };
}

/* ---------------------------------------------------------------- */
section("1. no credentials");
const anonymous = await call("apply", null, { context: basket });
row("POST /v1/apply", `${anonymous.status} ${anonymous.body.error?.code ?? ""}`);
console.log("   Before this layer, there was nothing to present and nothing checking.");

section("2. a storefront quotes a price");
const quote = await call("apply", storefrontKey, { context: basket });
row("POST /v1/apply", String(quote.status));
row("discount", `${quote.body.decision?.payableReduction?.minor ?? "-"} minor units`);
console.log("   Exact integers survive the wire as ~bigint: tagged strings, because a");
console.log("   JSON number is a double in every language and would round silently.");

section("3. the same storefront tries to commit value");
const overreach = await call("redeem", storefrontKey, { context: basket, idempotencyKey: "x" });
row("POST /v1/redeem", `${overreach.status} ${overreach.body.error?.code ?? ""}`);
row("reason", String(overreach.body.error?.message ?? ""));
console.log("   Quoting and committing are different privileges. A compromised");
console.log("   storefront key cannot grant anybody anything.");

section("4. the checkout service redeems, and claims to be somebody else");
const spoofed = await call("redeem", checkoutKey, {
  context: basket,
  actor: "ceo@acme.example",   // a lie, in the request body
  idempotencyKey: "order-1",
});
row("POST /v1/redeem", String(spoofed.status));

const audit = must(await platform.capabilities.audit({ tenant: TENANT }), "audit");
const captured = audit.recent.find((record) => record.kind === "execution.captured");
row("claimed actor", "ceo@acme.example");
row("recorded actor", String(captured?.actor));
console.log("   The body cannot name the actor. `actor` and `tenant` are overwritten");
console.log("   from the authenticated principal before the capability ever sees them.");

/* ---------------------------------------------------------------- */
section("5. rate limiting");
let refused = 0;
for (let i = 0; i < 60; i += 1) {
  const attempt = await call("redeem", checkoutKey, { context: basket, idempotencyKey: `burst-${i}` });
  if (attempt.status === 429) refused += 1;
}
row("60 rapid redemptions", `${60 - refused} allowed, ${refused} refused with 429`);
console.log("   Value-committing capabilities get the tightest policy: a runaway loop");
console.log("   here does not waste CPU, it moves money.");

/* ---------------------------------------------------------------- */
section("6. what an integrator can discover without a key");
const capabilities = await fetch(`${base}/capabilities`);
row("GET /v1/capabilities", `${capabilities.status}, ${((await capabilities.json()) as { capabilities: unknown[] }).capabilities.length} verbs`);

const document = generateOpenApi(capabilityRegistry(), { roles: roleRegistry(), servers: [base] });
row("OpenAPI paths", String(Object.keys(document.paths as object).length));
console.log("   Generated from the capability descriptors, so it cannot drift from");
console.log("   what the platform actually accepts.");

/* ---------------------------------------------------------------- */
section("7. the roles audit themselves");
for (const finding of findSeparationOfDutiesIssues(roleRegistry())) {
  row(finding.role, finding.reason);
}
console.log("   Only platform.admin is flagged, and it is meant to be. The shipped");
console.log("   finance role was split into funding and treasury because this check");
console.log("   caught it holding both `fund` and `pay` before it ever shipped.\n");

server.close();
