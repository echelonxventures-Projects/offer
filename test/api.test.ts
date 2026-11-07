/**
 * The API layer: authentication, authorisation, rate limiting, transport.
 *
 * The single most important test in this file is "the body cannot name the
 * actor". Until this layer existed, `actor` came out of the request body and
 * was believed, so anyone who could reach `redeem` could grant themselves
 * benefits and attribute them to somebody else.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import {
  MemoryApiKeyStore,
  apiKeyAuthenticator,
  hmacAuthenticator,
  signHmacToken,
  secureEquals,
} from "../src/api/authentication.ts";
import { RoleAuthorizer, roleRegistry, findSeparationOfDutiesIssues } from "../src/api/authorization.ts";
import { MemoryRateLimiter, rateLimitPolicyRegistry, policyFor } from "../src/api/rate-limit.ts";
import { Gateway, resolveTenant } from "../src/api/gateway.ts";
import { createHttpServer } from "../src/api/http.ts";
import * as https from "node:https";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateOpenApi } from "../src/api/openapi.ts";
import { HTTP_STATUS } from "../src/api/status.ts";
import { capabilityRegistry, CAPABILITIES } from "../src/capabilities/descriptors.ts";
import { authenticatorRegistry } from "../src/api/authentication.ts";
import { MemoryTelemetry } from "../src/observability/telemetry.ts";

/**
 * A throwaway self-signed certificate for 127.0.0.1, so the TLS test needs no
 * fixture file and no private key is ever committed.
 *
 * Node can parse X.509 but cannot issue it, so the `openssl` command makes one,
 * valid for a day, in a temporary directory that is removed straight away.
 * Returns undefined when `openssl` is not installed; the test then skips and
 * says why. Only the client in this file trusts the certificate, and it trusts
 * exactly this one. A deployment presents a certificate a real CA signed; this
 * exists to prove the adapter wires TLS through, not to recommend self-signing.
 */
function selfSigned(): { key: string; cert: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), "goip-tls-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    const made = spawnSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=goip-test",
        "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath],
      { stdio: "ignore" },
    );
    if (made.error || made.status !== 0) return undefined;
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** POST over HTTPS, trusting only `ca`. Node's fetch ignores an https.Agent, so this uses https.request. */
function postTls(
  port: number,
  path: string,
  ca: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      { host: "127.0.0.1", port, path, method: "POST", ca, headers: { ...headers, "content-length": Buffer.byteLength(body) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
import { encode } from "../src/kernel/codec.ts";
import { TENANT, cartContext, funded, publish, simpleDraft, unwrap } from "./_helpers.ts";

const SPEC_ERRORS = JSON.parse(readFileSync(new URL("../spec/errors.json", import.meta.url), "utf8")) as {
  codes: { code: string; http: number }[];
};

/** A gateway over a funded platform, with one key per role under test. */
async function harness(options: { nowMs?: () => number } = {}) {
  const platform = await funded();
  await publish(platform, simpleDraft());

  const keys = new MemoryApiKeyStore();
  const telemetry = new MemoryTelemetry();
  const secrets: Record<string, string> = {};

  const issue = (id: string, roles: string[], tenants: string[] = [TENANT]) => {
    const { secret } = keys.issue({ id, label: id, tenants, roles });
    secrets[id] = `${id}.${secret}`;
    return secrets[id] as string;
  };

  issue("checkout", ["commerce.checkout"]);
  issue("surface", ["commerce.surface"]);
  issue("author", ["campaign.author"]);
  issue("approver", ["campaign.approver"]);
  issue("funding", ["finance.funding"]);
  issue("treasury", ["finance.treasury"]);
  issue("multi", ["commerce.checkout"], [TENANT, "other-tenant"]);
  issue("stranger", ["commerce.checkout"], ["other-tenant"]);

  const gateway = new Gateway({
    capabilities: platform.capabilities,
    descriptors: capabilityRegistry(),
    authenticators: authenticatorRegistry().registerAll([apiKeyAuthenticator({ store: keys })]),
    authorizer: new RoleAuthorizer(roleRegistry()),
    rateLimiter: new MemoryRateLimiter(),
    ratePolicies: rateLimitPolicyRegistry(),
    telemetry,
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });

  const call = (capability: string, key: string, payload: Record<string, unknown> = {}, extra = {}) =>
    gateway.handle({
      capability,
      payload,
      credentials: { scheme: "apikey", token: secrets[key] },
      ...extra,
    });

  return { platform, gateway, keys, telemetry, secrets, call };
}

describe("the body cannot name the actor", () => {
  test("a redemption is attributed to the principal, whatever the body claims", async () => {
    const { platform, call } = await harness();

    const response = await call("redeem", "checkout", {
      context: cartContext(),
      actor: "ceo@example.com", // a lie
      idempotencyKey: "k1",
    });
    assert.equal(response.status, 200);

    const audit = unwrap(await platform.capabilities.audit({ tenant: TENANT }));
    const captured = audit.recent.find((record) => record.kind === "execution.captured");
    assert.ok(captured);
    assert.notEqual(captured!.actor, "ceo@example.com", "the claimed actor must not be believed");
    assert.equal(captured!.actor, "checkout", "the authenticated principal is recorded instead");
  });

  test("the actor is who performed it; the subject is who it was for", async () => {
    const { platform, call } = await harness();
    await call("redeem", "checkout", { context: cartContext(), idempotencyKey: "k2" });

    const audit = unwrap(await platform.capabilities.audit({ tenant: TENANT }));
    const reserved = audit.recent.find((record) => record.kind === "execution.reserved")!;

    // Conflating the two is exactly what an investigation cannot afford.
    assert.equal(reserved.actor, "checkout", "the caller");
    assert.equal((reserved.payload as { subjectId: string }).subjectId, "s1", "the beneficiary");
  });

  test("an authoring call records the authenticated principal as author", async () => {
    const { platform, call } = await harness();

    await call("create", "author", {
      actor: "somebody-else",
      draft: simpleDraft({ name: "Attributed" }),
    });

    const exchanges = unwrap(await platform.store.exchanges.find(TENANT));
    const created = exchanges.find((exchange) => exchange.name === "Attributed");
    assert.equal(created!.createdBy, "author");
  });

  test("the body cannot reach another tenant", async () => {
    const { platform, call } = await harness();

    // A principal scoped to `test` writes `tenant: "other-tenant"` in the body.
    const response = await call("create", "author", {
      tenant: "other-tenant",
      draft: simpleDraft({ name: "Crosses tenants" }),
    });
    assert.equal(response.status, 200, "the body field is ignored, not an error");

    const elsewhere = unwrap(await platform.store.exchanges.find("other-tenant"));
    assert.equal(elsewhere.length, 0, "nothing was written to the other tenant");
  });

  test("an explicit tenant header outside the principal's scope is refused", async () => {
    const { call } = await harness();
    const response = await call("apply", "checkout", { context: cartContext() }, { tenant: "other-tenant" });
    assert.equal(response.status, 403);
  });
});

describe("authentication", () => {
  test("no credentials is a refusal, not an anonymous call", async () => {
    const { gateway } = await harness();
    const response = await gateway.handle({ capability: "apply", payload: { context: cartContext() } });
    assert.equal(response.status, 403);
  });

  test("a wrong secret and an unknown key are indistinguishable", async () => {
    const { gateway, secrets } = await harness();
    const wrongSecret = await gateway.handle({
      capability: "apply",
      payload: {},
      credentials: { scheme: "apikey", token: "checkout.not-the-secret" },
    });
    const unknownKey = await gateway.handle({
      capability: "apply",
      payload: {},
      credentials: { scheme: "apikey", token: "nobody.at-all" },
    });

    assert.equal(wrongSecret.status, 403);
    assert.equal(unknownKey.status, 403);
    assert.deepEqual(
      (wrongSecret.body as { error: { message: string } }).error.message,
      (unknownKey.body as { error: { message: string } }).error.message,
      "the error must not reveal whether the key exists",
    );
    assert.ok(secrets.checkout);
  });

  test("a revoked key stops working", async () => {
    const { call, keys } = await harness();
    assert.equal((await call("apply", "checkout", { context: cartContext() })).status, 200);
    keys.revoke("checkout");
    assert.equal((await call("apply", "checkout", { context: cartContext() })).status, 403);
  });

  test("an expired key stops working", async () => {
    const keys = new MemoryApiKeyStore();
    const { secret } = keys.issue({ id: "k", tenants: ["t"], roles: ["auditor"], expiresAt: "1000" });
    const authenticator = apiKeyAuthenticator({ store: keys, now: () => 2000n });
    const result = await authenticator.authenticate({ token: `k.${secret}` });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /expired/);
  });

  test("a secret is never stored in plaintext", async () => {
    const keys = new MemoryApiKeyStore();
    const { record, secret } = keys.issue({ id: "k", tenants: ["t"], roles: [] });
    assert.notEqual(record.secretHash, secret);
    assert.equal(record.secretHash.length, 64, "stored as a sha256 hex digest");
    assert.equal(JSON.stringify(record).includes(secret), false);
  });

  test("secureEquals compares correctly across lengths", () => {
    assert.equal(secureEquals("abc", "abc"), true);
    assert.equal(secureEquals("abc", "abd"), false);
    assert.equal(secureEquals("abc", "much longer string"), false);
    assert.equal(secureEquals("", ""), true);
  });
});

describe("HMAC tokens", () => {
  const secret = "shared-secret";
  const authenticator = hmacAuthenticator({ secret, now: () => 1000n });

  test("a validly signed token authenticates", async () => {
    const token = signHmacToken({ sub: "svc", tenants: ["t"], roles: ["auditor"] }, secret);
    const result = await authenticator.authenticate({ token });
    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.value.id, "svc");
  });

  test("a tampered payload does not verify", async () => {
    const token = signHmacToken({ sub: "svc", tenants: ["t"], roles: ["auditor"] }, secret);
    const [body, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "svc", tenants: ["t"], roles: ["platform.admin"] })).toString("base64url");
    const result = await authenticator.authenticate({ token: `${forged}.${signature}` });
    assert.equal(result.ok, false);
    assert.ok(body);
  });

  test("a token signed with a different secret does not verify", async () => {
    const token = signHmacToken({ sub: "svc", tenants: ["t"], roles: [] }, "other-secret");
    assert.equal((await authenticator.authenticate({ token })).ok, false);
  });

  test("an expired token is refused", async () => {
    const token = signHmacToken({ sub: "svc", tenants: ["t"], roles: [], exp: "500" }, secret);
    const result = await authenticator.authenticate({ token });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /expired/);
  });

  test("missing claims are refused rather than defaulted", async () => {
    const token = signHmacToken({ sub: "", tenants: [], roles: [] } as never, secret);
    assert.equal((await authenticator.authenticate({ token })).ok, false);
  });
});

describe("authorisation", () => {
  test("a surface may quote but may not commit value", async () => {
    const { call } = await harness();
    assert.equal((await call("apply", "surface", { context: cartContext() })).status, 200);

    const redeem = await call("redeem", "surface", { context: cartContext(), idempotencyKey: "k" });
    assert.equal(redeem.status, 403, "quoting and committing are different privileges");
  });

  test("funding may create budgets but may not pay out, and vice versa", async () => {
    const { call } = await harness();

    const funded = await call("fund", "funding", {
      sourceId: "new", label: "New", party: { kind: "merchant", id: "m" }, unit: "USD", budgetDecimal: "10.00",
    });
    assert.equal(funded.status, 200);

    // Funding a budget and paying out of it is the classic collapsed duty.
    const paidByFunder = await call("pay", "funding", {
      fromAccountId: "pay:affiliate:x:USD", destination: { kind: "bank", reference: "acct" },
      unit: "USD", decimal: "1.00",
    });
    assert.equal(paidByFunder.status, 403);

    // And treasury cannot create the budget it pays from.
    const fundedByTreasury = await call("fund", "treasury", {
      sourceId: "other", label: "Other", party: { kind: "merchant", id: "m" }, unit: "USD", budgetDecimal: "10.00",
    });
    assert.equal(fundedByTreasury.status, 403);

    // Neither may author offers.
    assert.equal((await call("create", "funding", { draft: simpleDraft() })).status, 403);
  });

  test("separation of duties holds at the door, not just in governance", async () => {
    const { call } = await harness();

    // The author can create but not publish.
    const created = await call("create", "author", { draft: simpleDraft({ name: "Needs approval" }) });
    assert.equal(created.status, 200);
    const id = (created.body as { value: { id: string } }).value?.id ?? (created.body as { id: string }).id;
    assert.equal((await call("publish", "author", { valueExchangeId: id })).status, 403);

    // The approver can publish but not create.
    assert.equal((await call("create", "approver", { draft: simpleDraft() })).status, 403);
  });

  test("an unknown capability is refused before authentication is attempted", async () => {
    const { gateway } = await harness();
    const response = await gateway.handle({ capability: "sudo", payload: {} });
    assert.equal(response.status, 404);
  });

  test("the shipped roles are audited for collapsed duties", () => {
    const findings = findSeparationOfDutiesIssues(roleRegistry());
    const flagged = findings.map((finding) => finding.role);

    assert.ok(flagged.includes("platform.admin"), "an admin role must be flagged as separating nothing");
    assert.equal(flagged.includes("campaign.author"), false, "the author role must not also publish");
    assert.equal(flagged.includes("campaign.approver"), false);
    assert.equal(flagged.includes("finance.funding"), false, "funding must not also pay out");
    assert.equal(flagged.includes("finance.treasury"), false, "treasury must not also fund");
  });

  test("granted() reports exactly what a principal may invoke", () => {
    const authorizer = new RoleAuthorizer(roleRegistry());
    const granted = authorizer.granted(
      { id: "p", tenants: ["t"], roles: ["auditor"], method: "test" },
      CAPABILITIES,
    );
    assert.ok(granted.includes("audit"));
    assert.equal(granted.includes("redeem"), false);
  });
});

describe("tenant resolution", () => {
  const principal = (tenants: string[]) => ({ id: "p", tenants, roles: [], method: "test" });

  test("a single-tenant principal needs no tenant field at all", () => {
    assert.equal(unwrap(resolveTenant(undefined, principal(["acme"]))), "acme");
  });

  test("a multi-tenant principal must state which", () => {
    const result = resolveTenant(undefined, principal(["a", "b"]));
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /must be stated/);
  });

  test("a wildcard principal must state which", () => {
    assert.equal(resolveTenant(undefined, principal(["*"])).ok, false);
    assert.equal(unwrap(resolveTenant("anything", principal(["*"]))), "anything");
  });

  test("an out-of-scope tenant is refused", () => {
    assert.equal(resolveTenant("c", principal(["a", "b"])).ok, false);
  });
});

describe("rate limiting", () => {
  test("a per-principal limit refuses and reports when to retry", async () => {
    let now = 0;
    const { call } = await harness({ nowMs: () => now });

    // The authoring policy is 5/s with a burst of 20.
    const results = [];
    for (let i = 0; i < 25; i += 1) {
      results.push(await call("create", "author", { draft: simpleDraft({ name: `n${i}` }) }));
    }
    const refused = results.filter((response) => response.status === 429);
    assert.ok(refused.length > 0, "a burst beyond capacity must be refused");
    assert.ok(Number(refused[0]!.headers["retry-after"]) >= 0, "Retry-After tells the caller when");

    // The bucket refills.
    now += 10_000;
    assert.equal((await call("create", "author", { draft: simpleDraft({ name: "later" }) })).status, 200);
  });

  test("the pre-authentication limit stops credential brute-forcing", async () => {
    let now = 0;
    const { gateway } = await harness({ nowMs: () => now });

    const attempts = [];
    for (let i = 0; i < 40; i += 1) {
      attempts.push(
        await gateway.handle({
          capability: "apply",
          payload: {},
          credentials: { scheme: "apikey", token: `guess.${i}` },
          source: "198.51.100.7",
        }),
      );
    }
    assert.ok(
      attempts.some((response) => response.status === 429),
      "guessing must be rate limited before authentication, since there is no principal yet",
    );
  });

  test("one noisy caller does not exhaust another's budget", async () => {
    let now = 0;
    const { call } = await harness({ nowMs: () => now });
    for (let i = 0; i < 25; i += 1) await call("create", "author", { draft: simpleDraft({ name: `x${i}` }) });

    // A different principal, different bucket.
    assert.equal((await call("apply", "checkout", { context: cartContext() })).status, 200);
  });

  test("policies are selected most-specific-first", () => {
    const policies = rateLimitPolicyRegistry();
    assert.equal(policyFor(policies, "redeem").key, "financial");
    assert.equal(policyFor(policies, "apply").key, "read");
    assert.equal(policyFor(policies, "track").key, "default");
  });

  test("the limiter bounds its own key space", () => {
    const limiter = new MemoryRateLimiter({ maxKeys: 10 });
    const policy = { key: "p", label: "p", perSecond: 1, burst: 1 };
    for (let i = 0; i < 100; i += 1) limiter.consume(`key-${i}`, policy, 0);
    // No assertion on internals; the point is that it does not grow unbounded.
    assert.equal(limiter.consume("key-0", policy, 0).allowed, true);
  });
});

describe("status mapping", () => {
  test("agrees with spec/errors.json", () => {
    for (const entry of SPEC_ERRORS.codes) {
      const mapped = HTTP_STATUS[entry.code as keyof typeof HTTP_STATUS];
      assert.ok(mapped !== undefined, `${entry.code} has no HTTP status`);
      // LIMIT_EXCEEDED is deliberately 429 at the transport boundary; the spec
      // documents the business meaning as 409. That divergence is intentional
      // and documented in status.ts.
      if (entry.code !== "LIMIT_EXCEEDED") {
        assert.equal(mapped, entry.http, `${entry.code}: transport and spec disagree`);
      }
    }
  });

  test("every error code has a status", () => {
    assert.equal(Object.keys(HTTP_STATUS).length, SPEC_ERRORS.codes.length);
  });
});

describe("HTTP transport", () => {
  async function serve() {
    const { gateway, secrets, platform } = await harness();
    const server = createHttpServer({
      gateway,
      descriptors: capabilityRegistry(),
      health: async () => true,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { server, port, secrets, platform };
  }

  test("a capability round-trips over real HTTP", async () => {
    const { server, port, secrets } = await serve();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/apply`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `ApiKey ${secrets.checkout}` },
        // A client serialises with the wire codec for the same reason the
        // server does: JSON.stringify cannot represent an exact integer, and
        // a cart line's unit price is one.
        body: encode({ context: cartContext() }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");

      const body = (await response.json()) as { decision: { payableReduction: { minor: string } } };
      assert.equal(body.decision.payableReduction.minor, "~bigint:1000", "exact integers survive the wire");
    } finally {
      server.close();
    }
  });

  test("an unauthenticated request is refused with JSON", async () => {
    const { server, port } = await serve();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/apply`, { method: "POST", body: "{}" });
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "FORBIDDEN");
    } finally {
      server.close();
    }
  });

  test("the capability list and health are reachable without credentials", async () => {
    const { server, port } = await serve();
    try {
      const capabilities = await fetch(`http://127.0.0.1:${port}/v1/capabilities`);
      assert.equal(capabilities.status, 200);
      assert.equal(((await capabilities.json()) as { capabilities: unknown[] }).capabilities.length, 22);

      const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
      assert.equal(health.status, 200);
    } finally {
      server.close();
    }
  });

  test("an oversized body is rejected while it is being read", async () => {
    const { gateway } = await harness();
    const server = createHttpServer({ gateway, descriptors: capabilityRegistry(), maxBodyBytes: 64 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(5000) }),
      });
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: { message: string } }).error.message, /too large/);
    } finally {
      server.close();
    }
  });

  test("TLS serves the same gateway over HTTPS", async (t) => {
    const pair = selfSigned();
    if (pair === undefined) {
      t.skip("the openssl command is not installed, so no test certificate can be made");
      return;
    }
    const { gateway, secrets } = await harness();
    const server = createHttpServer({
      gateway,
      descriptors: capabilityRegistry(),
      tls: { key: pair.key, cert: pair.cert },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      // The client trusts exactly this certificate and nothing else; verification stays on.
      const response = await postTls(
        port,
        "/v1/apply",
        pair.cert,
        { "content-type": "application/json", authorization: `ApiKey ${secrets.checkout}` },
        encode({ context: cartContext() }),
      );
      assert.equal(response.status, 200, "the same handler answered over TLS");
      const body = JSON.parse(response.body) as { decision: { payableReduction: { minor: string } } };
      assert.equal(body.decision.payableReduction.minor, "~bigint:1000");
    } finally {
      server.close();
    }
  });

  test("partial TLS is refused rather than silently plaintext", () => {
    assert.throws(
      () =>
        createHttpServer({
          gateway: null as never,
          descriptors: capabilityRegistry(),
          // @ts-expect-error a key without a cert is the misconfiguration under test
          tls: { key: "k" },
        }),
      /requires both a key and a cert/,
    );
  });

  test("an unknown route is a 404, not a crash", async () => {
    const { server, port } = await serve();
    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
    } finally {
      server.close();
    }
  });
});

describe("OpenAPI", () => {
  test("covers every capability, with security applied", () => {
    const document = generateOpenApi(capabilityRegistry(), { roles: roleRegistry() });
    const paths = document.paths as Record<string, { post?: { security?: unknown[] } }>;

    for (const capability of CAPABILITIES) {
      const path = paths[`/v1/${capability.key}`];
      assert.ok(path, `${capability.key} is missing from the document`);
      assert.ok(path.post?.security, `${capability.key} has no security requirement`);
    }
  });

  test("documents every error code it can return", () => {
    const document = generateOpenApi(capabilityRegistry());
    const schemas = (document.components as { schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } } }).schemas;
    assert.deepEqual(schemas.Error.properties.error.properties.code.enum.sort(), Object.keys(HTTP_STATUS).sort());
  });

  test("value-committing capabilities are marked as such for integrators", () => {
    const document = generateOpenApi(capabilityRegistry());
    const paths = document.paths as Record<string, { post: { description: string } }>;
    assert.match(paths["/v1/redeem"]!.post.description, /Commits value/);
    assert.match(paths["/v1/apply"]!.post.description, /Read-only/);
  });
});
