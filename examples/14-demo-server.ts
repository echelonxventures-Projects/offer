/**
 * Example 14 - a live demo server.
 *
 * The other examples are narratives: each runs to completion and exits. This one
 * stays up, so a person can point a client at it.
 *
 * It boots a real HTTP gateway on a fixed port, seeds a tenant with a funded
 * budget and a published offer, issues four API keys covering the four roles
 * worth demonstrating, proves the interesting paths work before printing
 * anything, and then waits. Ctrl-C shuts it down cleanly.
 *
 * What it deliberately is not: a production endpoint. Keys live in process, the
 * store is in memory, and a restart gives you a clean slate - which is the right
 * thing for a demo and the wrong thing for a platform. Durability is example 07;
 * Postgres is example 13.
 *
 *   GOIP_DEMO_PORT=9119 node examples/14-demo-server.ts
 *   node examples/14-demo-server.ts 9119
 */
import type { AddressInfo } from "node:net";
import { GoipPlatform } from "../src/platform/platform.ts";
import { MemoryApiKeyStore, apiKeyAuthenticator } from "../src/api/authentication.ts";
import { createGateway, createHttpServer, generateOpenApi } from "../src/api/index.ts";
import { roleRegistry, findSeparationOfDutiesIssues, RoleAuthorizer } from "../src/api/authorization.ts";
import { capabilityRegistry } from "../src/capabilities/descriptors.ts";
import { MemoryTelemetry } from "../src/observability/telemetry.ts";
import { MaintenanceScheduler } from "../src/operations/scheduler.ts";
import { encode } from "../src/kernel/codec.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { TENANT, heading, must, row, section } from "./_bootstrap.ts";
import { simpleOffer } from "./_fixtures.ts";

const DEFAULT_PORT = 9119;
const MAINTENANCE_INTERVAL_MS = 60_000;

const port = Number(process.env.GOIP_DEMO_PORT ?? process.argv[2] ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`port must be an integer in 1-65535, got '${process.argv[2] ?? process.env.GOIP_DEMO_PORT}'`);
  process.exit(1);
}

heading("GOIP DEMO SERVER - a live instance you can call");

/* ---------------------------------------------------------------- */
section("setup: a tenant, a budget, and a published offer");

const telemetry = new MemoryTelemetry();
// The platform defaults to the system clock; an injected one is only needed to
// make a narrative reproducible. A live server wants real time.
const platform = new GoipPlatform({ ids: sequentialIdFactory(), telemetry });

must(
  await platform.capabilities.fund({
    tenant: TENANT, actor: "ops", sourceId: "merchant-acme", label: "Acme demo budget",
    party: { kind: "merchant", id: "acme" }, unit: "USD", budgetDecimal: "5000.00",
  }),
  "fund the demo budget",
);
const offer = must(
  await platform.capabilities.create({ tenant: TENANT, actor: "ops", draft: simpleOffer("Everyday 10% off") }),
  "create the demo offer",
);
must(
  await platform.capabilities.publish({
    tenant: TENANT, actor: "ops", valueExchangeId: offer.id, approvedBy: "finance@demo",
  }),
  "publish the demo offer",
);
row("tenant", TENANT);
row("offer", `${offer.name} (${offer.id})`);
row("benefit", "10% off the cart, automatic, no code");
row("budget", "5000.00 USD, single funder");

/* ---------------------------------------------------------------- */
section("credentials: four keys, four roles");

const keys = new MemoryApiKeyStore();
const issue = (id: string, roles: string[]) => {
  const { secret } = keys.issue({ id, label: id, tenants: [TENANT], roles });
  return `${id}.${secret}`;
};

// Each key is scoped to the one tenant, so the tenant is resolved from the
// principal and a caller cannot name the wrong one even by accident.
const credentials = {
  storefront: issue("demo-storefront", ["commerce.surface"]),
  checkout: issue("demo-checkout", ["commerce.checkout"]),
  finance: issue("demo-finance", ["finance.funding"]),
  admin: issue("demo-admin", ["platform.admin"]),
};

row("demo-storefront", `${credentials.storefront}`);
console.log("     commerce.surface - quotes and discovers. Cannot commit value.");
row("demo-checkout", `${credentials.checkout}`);
console.log("     commerce.checkout - the only role that may redeem on a customer's behalf.");
row("demo-finance", `${credentials.finance}`);
console.log("     finance.funding - funds budgets, settles, audits. Deliberately cannot pay out.");
row("demo-admin", `${credentials.admin}`);
console.log("     platform.admin - everything. Flagged by the separation-of-duties audit, as intended.");
console.log("\n     Secrets are printed here once and stored only as a hash; copy them now.");

/* ---------------------------------------------------------------- */
section("listening");

const gateway = createGateway(platform, {
  authenticators: [apiKeyAuthenticator({ store: keys })],
  // A real deployment swaps this authorizer for its own role model; the roles
  // themselves are a registry, not an enum.
  authorizer: new RoleAuthorizer(roleRegistry()),
  telemetry,
});
const server = createHttpServer({
  gateway,
  descriptors: capabilityRegistry(),
  health: async () => (await platform.health.check(TENANT)).ok === true,
});

await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
  server.listen(port, "127.0.0.1");
});
const { port: bound } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${bound}/v1`;
row("base url", base);
row("health", `GET ${base}/health`);
row("capabilities", `GET ${base}/capabilities  (no key needed)`);

/**
 * The one critical gap on the platform's own list was that nothing triggered
 * maintenance - it deliberately owns no timer. `MaintenanceScheduler` is the
 * opt-in answer for a deployment that has no scheduler of its own. Every tick it
 * asks the runner what is due; the runner decides, this only asks.
 */
const scheduler = new MaintenanceScheduler({
  runner: platform.maintenance,
  intervalMs: MAINTENANCE_INTERVAL_MS,
  tenants: [TENANT],
  telemetry,
});
await scheduler.start();
row("maintenance", `every ${MAINTENANCE_INTERVAL_MS / 1000}s via the opt-in scheduler`);

/* ---------------------------------------------------------------- */
section("self-check: proving it works before saying it does");

const basket = {
  unit: "USD",
  channel: "web",
  subject: { id: "shopper-1" },
  cart: {
    lines: [
      { id: "l1", sku: "WIDGET", quantity: 2, unitPrice: { unit: "USD", minor: 5_000n, scale: 2 }, categories: [] },
    ],
  },
};

/**
 * The wire codec tags exact integers as `~bigint:1000` rather than emitting a
 * JSON number, because a JSON number is a double in every language and would
 * round silently. This strips the tag for display; a client keeps the exact
 * string.
 */
const minor = (tagged?: string): string =>
  typeof tagged === "string" && tagged.startsWith("~bigint:") ? tagged.slice("~bigint:".length) : tagged ?? "-";

async function call(capability: string, key: string | null, payload: unknown) {
  const response = await fetch(`${base}/${capability}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { authorization: `ApiKey ${key}` }),
    },
    body: encode(payload),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      error?: { code?: string; message?: string };
      decision?: { payableReduction?: { minor?: string }; searchMode?: string };
    },
  };
}

const probe = async (what: string, capability: string, key: string | null, payload: unknown) => {
  const result = await call(capability, key, payload);
  row(what, `${result.status} ${result.body.error?.code ?? "ok"}`);
  return result;
};

// Non-mutating checks first, so the demo starts with its budget intact.
const healthy = await fetch(`${base}/health`);
const healthBody = (await healthy.json()) as { status?: string };
row("GET health", `${healthy.status} ${healthBody.status ?? ""}`);

await probe("apply, unauthenticated", "apply", null, { context: basket });
const quote = await probe("apply, storefront key", "apply", credentials.storefront, { context: basket });
row("discount", `${minor(quote.body.decision?.payableReduction?.minor)} minor units off a 100.00 cart`);
await probe("redeem, storefront key", "redeem", credentials.storefront, {
  context: basket,
  idempotencyKey: "self-check",
});
console.log("     The last one is a refusal, and the point: a quoting key cannot commit value.");
console.log("     Exact integers arrive as ~bigint: tagged strings, not JSON numbers, so they cannot round.");

if (quote.status !== 200 || minor(quote.body.decision?.payableReduction?.minor) !== "1000") {
  console.error("\n  SELF-CHECK FAILED: the demo is not working as described. Not printing commands.");
  server.close();
  process.exit(1);
}

/* ---------------------------------------------------------------- */
section("paste-ready commands");

const header = (key: string) => `-H "authorization: ApiKey ${key}"`;
const body = (payload: unknown) => `-d '${encode(payload)}'`;

console.log(`\n  # Quote a price (storefront key - safe, commits nothing)`);
console.log(`  curl -s ${header(credentials.storefront)} ${body({ context: basket })} ${base}/apply | jq .`);

console.log(`\n  # Commit value (checkout key - this one moves money)`);
console.log(`  curl -s ${header(credentials.checkout)} ${body({
    context: basket,
    idempotencyKey: "order-1",
  })} ${base}/redeem | jq .`);

console.log(`\n  # Try to be somebody else - the body cannot name the actor. The claim is in`);
console.log(`  # the request; the truth is in the audit chain, read with the finance key.`);
console.log(`  curl -s ${header(credentials.checkout)} ${body({
    context: basket,
    actor: "ceo@demo.example",
    idempotencyKey: "spoof-1",
  })} ${base}/redeem > /dev/null`);
console.log(`  curl -s ${header(credentials.finance)} -d '{}' ${base}/audit \\
    | jq '.recent[] | select(.kind=="execution.captured") | .actor'   # demo-checkout, not the claim`);

console.log(`\n  # Hammer a value-committing capability - the tightest rate policy`);
console.log(`  for i in $(seq 1 60); do curl -s -o /dev/null -w "%{http_code} " ${header(credentials.checkout)} \\
    ${body({ context: basket, idempotencyKey: "burst-$i" })} ${base}/redeem; done; echo`);

console.log(`\n  # What an integrator can discover without a key`);
console.log(`  curl -s ${base}/capabilities | jq '.capabilities | length'`);

console.log(`\n  # The full API contract, generated from the capability descriptors`);
console.log(`  curl -s ${base}/capabilities >/dev/null && echo "openapi: generateOpenApi() in src/api"`);
console.log(`\n  # Roles that collapse a separation of duties (advisory)`);
for (const finding of findSeparationOfDutiesIssues(roleRegistry())) {
  console.log(`  ${finding.role} - ${finding.reason}`);
}

/* ---------------------------------------------------------------- */
section("ready");

row("stop", "Ctrl-C");
console.log("\n  In-memory store: a restart clears counters, reservations and the budget.");
console.log("  Durability is examples/07-durability.ts; Postgres is examples/13-postgres.ts.\n");

const shutdown = (signal: string) => {
  scheduler.stop();
  server.close(() => {
    row("shutdown", `${signal}: server closed`);
    process.exit(0);
  });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// The OpenAPI document is generated from the same descriptors the gateway
// dispatches on, so it cannot drift from what the server actually accepts.
const document = generateOpenApi(capabilityRegistry(), { roles: roleRegistry(), servers: [base] });
row("openapi paths", String(Object.keys(document.paths as object).length));
