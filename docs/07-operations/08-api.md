# Running the API

```ts
const gateway = createGateway(platform, {
  authenticators: [apiKeyAuthenticator({ store: keys })],
});
createHttpServer({ gateway, descriptors: capabilityRegistry() }).listen(8080);
```

That is the whole thing. No framework.

---

## The request pipeline

| Step | Refuses with | Why it is here |
| --- | --- | --- |
| 1. Unknown capability | 404 | Before authentication: tells an attacker nothing, and saves the work |
| 2. Pre-auth rate limit, by source | 429 | Brute-forcing has no principal yet, so a per-principal limit cannot see it |
| 3. Authenticate | 403 | |
| 4. Resolve tenant | 403 / 400 | |
| 5. Authorise | 403 | |
| 6. Per-principal rate limit | 429 | After auth, so one noisy integration cannot exhaust everyone's budget |
| 7. **Override `actor` and `tenant`** | — | The body cannot name the actor |

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/<capability>` | Yes | Invoke a capability |
| `GET /v1/capabilities` | No | The surface of this deployment |
| `GET /v1/health` | No | Integrity health; 503 when unhealthy |

## Headers

| Header | Required | Notes |
| --- | --- | --- |
| `Authorization` | Yes | `ApiKey <id>.<secret>` or `Bearer <claims>.<hmac>` |
| `X-Goip-Tenant` | Only if multi-tenant | A single-tenant principal has it resolved; there is no field to get wrong |
| `X-Correlation-Id` | No | Flows into the decision and every audit record it produces |

## Exact integers on the wire

`JSON.stringify` cannot represent a `bigint`, and a JSON *number* is a double in
every language — it would round a large minor-unit value silently. So amounts
cross the wire as tagged strings:

```json
{ "payableReduction": { "unit": "USD", "minor": "~bigint:1000", "scale": 2 } }
```

**Clients must use the codec too.** `encode()` / `decode()` from
`src/kernel/codec.ts`, or the equivalent in your language — the rule is in
[`spec/encoding.md`](../../spec/encoding.md) and covered by conformance vectors.

## Roles

Shipped as a starting point, not a policy. The two worth understanding:

| Role | May | May not |
| --- | --- | --- |
| `commerce.surface` | Quote, discover, track | **Commit value** |
| `commerce.checkout` | Quote, reserve, redeem, reverse | Author or fund |

A caller holding `commerce.checkout` can grant benefits. It belongs to a
service, never to a person.

`campaign.author` cannot publish and `campaign.approver` cannot create, so
separation of duties holds at the door as well as in governance.

```ts
findSeparationOfDutiesIssues(roleRegistry());
// [{ role: "platform.admin", reason: "grants every capability; nothing is separated" }]
```

Run that over your own roles. It caught the shipped `finance` role holding both
`fund` and `pay` before it shipped, which is why there are now
`finance.funding` and `finance.treasury`.

## Rate limits

| Policy | Rate | Applies to |
| --- | --- | --- |
| `read` | 200/s, burst 400 | Quotes and discovery — pure and cheap |
| `default` | 50/s, burst 100 | Everything else |
| `financial` | 20/s, burst 40 | Reserve, redeem, fund, pay |
| `authoring` | 5/s, burst 20 | Create, publish, issue |
| `unauthenticated` | 5/s, burst 20 | Per source, before auth |

`financial` is tight on purpose: a runaway loop there does not waste CPU, it
moves money.

**The shipped limiter is per-instance.** With four instances the effective limit
is four times the configured one. Swap in a shared store for a real deployment;
the port is one method.

## What is still missing

- **No row-level authorisation.** A principal that may `publish` may publish
  anything in its tenant.
- **No key rotation workflow.** `MemoryApiKeyStore` issues and revokes; rotating
  without downtime needs overlapping validity, which a real store should add.
- **No mTLS or request signing.** Bearer credentials over TLS only.
- **`X-Forwarded-For` is deliberately ignored.** The rate limiter keys on the
  socket address, because an attacker controls the header. Behind a trusted
  proxy, substitute your own source when building the `ApiRequest`.
