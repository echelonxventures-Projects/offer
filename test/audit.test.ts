/**
 * The audit chain, and the canonicalisation it depends on.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeHash, findChainBreak, sealRecord, GENESIS_HASH } from "../src/audit/audit-log.ts";
import type { AuditDraft, AuditRecord } from "../src/audit/audit-log.ts";
import { MemoryPlatformStore } from "../src/adapters/memory-store.ts";
import { canonicalize } from "../src/kernel/canonical.ts";
import { hashValue } from "../src/kernel/hash.ts";
import { TENANT, cartContext, funded, publish, simpleDraft, unwrap } from "./_helpers.ts";

const draft = (n: number, tenant = "t"): AuditDraft => ({
  tenant,
  reality: "production",
  kind: "decision.made",
  subject: { kind: "decision", id: `d${n}` },
  actor: "tester",
  at: String(n),
  payload: { n },
});

describe("canonical encoding", () => {
  test("key order cannot change the bytes", () => {
    assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
    assert.equal(hashValue({ a: [1, { x: 1, y: 2 }] }), hashValue({ a: [1, { y: 2, x: 1 }] }));
  });

  test("bigint and number are encoded distinguishably", () => {
    assert.notEqual(canonicalize({ v: 1n }), canonicalize({ v: 1 }));
    assert.equal(canonicalize({ v: 10n }), '{"v":"~bigint:10"}');
  });

  test("absent and explicitly-undefined keys hash alike", () => {
    assert.equal(hashValue({ a: 1 }), hashValue({ a: 1, b: undefined }));
  });

  test("array order is significant", () => {
    assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  });
});

describe("hash chain primitives", () => {
  test("sealing links a record to the one before it", () => {
    const first = sealRecord(draft(1), 0, GENESIS_HASH);
    const second = sealRecord(draft(2), 1, first.hash);
    assert.equal(first.previousHash, GENESIS_HASH);
    assert.equal(second.previousHash, first.hash);
    assert.equal(findChainBreak([first, second]), null);
  });

  test("the hash is reproducible from the record's own contents", () => {
    const record = sealRecord(draft(1), 0, GENESIS_HASH);
    const { hash, ...rest } = record;
    assert.equal(computeHash(record.previousHash, rest), hash);
  });

  test("a modified payload is detected, and the sequence is named", () => {
    const records = [
      sealRecord(draft(1), 0, GENESIS_HASH),
      sealRecord(draft(2), 1, sealRecord(draft(1), 0, GENESIS_HASH).hash),
    ];
    const tampered = { ...records[1]!, payload: { n: 999 } } as AuditRecord;
    const broken = findChainBreak([records[0]!, tampered]);
    assert.equal(broken?.seq, 1);
    assert.equal(broken?.reason, "content");
  });

  test("a removed record is detected as a broken link", () => {
    const a = sealRecord(draft(1), 0, GENESIS_HASH);
    const b = sealRecord(draft(2), 1, a.hash);
    const c = sealRecord(draft(3), 2, b.hash);
    const broken = findChainBreak([a, c]); // b removed
    assert.equal(broken?.seq, 2);
    assert.equal(broken?.reason, "link");
  });

  test("an empty chain is intact", () => {
    assert.equal(findChainBreak([]), null);
  });
});

describe("the audit store", () => {
  test("assigns sequence numbers and verifies", async () => {
    const store = new MemoryPlatformStore();
    unwrap(await store.audit.append(draft(1)));
    const second = unwrap(await store.audit.append(draft(2)));
    assert.equal(second.seq, 1);
    const verified = unwrap(await store.audit.verify("t"));
    assert.equal(verified.records, 2);
    assert.equal(verified.head, unwrap(await store.audit.head("t")));
  });

  test("tenants have independent chains", async () => {
    const store = new MemoryPlatformStore();
    unwrap(await store.audit.append(draft(1, "t")));
    const other = unwrap(await store.audit.append(draft(1, "other")));
    assert.equal(other.previousHash, GENESIS_HASH);
    assert.equal(other.seq, 0);
  });

  test("tampering breaks verification and reports where", async () => {
    const store = new MemoryPlatformStore();
    for (const n of [1, 2, 3]) unwrap(await store.audit.append(draft(n)));

    const records = unwrap(await store.audit.recent("t", 10));
    (records[1] as unknown as { payload: Record<string, number> }).payload = { n: 999 };

    const verified = await store.audit.verify("t");
    assert.equal(verified.ok, false);
    assert.equal(verified.ok === false && verified.error.details?.seq, 1);
  });

  test("verification can resume from a trusted checkpoint", async () => {
    const store = new MemoryPlatformStore();
    for (const n of [1, 2, 3, 4]) unwrap(await store.audit.append(draft(n)));
    // Verifying from seq 2 does not re-walk the first two records.
    const verified = unwrap(await store.audit.verify("t", 2));
    assert.equal(verified.records, 4);
  });

  test("an empty chain verifies as empty rather than failing", async () => {
    const store = new MemoryPlatformStore();
    const verified = unwrap(await store.audit.verify("nobody"));
    assert.equal(verified.records, 0);
    assert.equal(verified.head, GENESIS_HASH);
  });
});

describe("what the platform records", () => {
  test("a full redemption leaves an auditable trail", async () => {
    const p = await funded();
    await publish(p, simpleDraft());
    unwrap(await p.capabilities.redeem({ context: cartContext(), actor: "checkout", idempotencyKey: "k" }));

    const audit = unwrap(await p.capabilities.audit({ tenant: TENANT }));
    assert.equal(audit.verified, true);
    assert.deepEqual(audit.recent.map((r) => r.kind), [
      "value_exchange.created",
      "value_exchange.transitioned",
      "value_exchange.transitioned",
      "value_exchange.transitioned",
      "execution.reserved",
      "execution.captured",
    ]);
  });

  test("the reserved record carries the decision hash, so the decision is replayable", async () => {
    const p = await funded();
    await publish(p, simpleDraft());
    const redeemed = unwrap(
      await p.capabilities.redeem({ context: cartContext(), actor: "checkout", idempotencyKey: "k" }),
    );
    const audit = unwrap(await p.capabilities.audit({ tenant: TENANT }));
    const reserved = audit.recent.find((r) => r.kind === "execution.reserved")!;
    assert.equal((reserved.payload as { decisionHash: string }).decisionHash, redeemed.decision.hash);
  });

  test("identical decisions hash identically across platform instances", async () => {
    const run = async () => {
      const p = await funded();
      await publish(p, simpleDraft());
      return unwrap(await p.capabilities.apply({ context: cartContext() })).decision.hash;
    };
    assert.equal(await run(), await run());
  });
});
