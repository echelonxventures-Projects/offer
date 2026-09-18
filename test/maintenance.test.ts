/**
 * Maintenance, checkpointing and external anchoring.
 *
 * The anchoring tests are the point of this file. Verification alone only
 * proves the chain is internally consistent - which a wholesale rewrite also
 * is. Comparing against an independently held hash is what makes
 * tamper-evidence mean anything.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GoipPlatform } from "../src/platform/platform.ts";
import { MemoryAuditAnchor, FileAuditAnchor } from "../src/audit/anchor.ts";
import type { AnchorFileSystem } from "../src/audit/anchor.ts";
import { MemoryTelemetry, fixedStopwatch } from "../src/observability/telemetry.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { sealRecord, findChainBreak, GENESIS_HASH } from "../src/audit/audit-log.ts";
import { AuditService } from "../src/audit/audit-service.ts";
import { TemporalAuthority } from "../src/universal/temporal/authority.ts";
import type { PlatformStore } from "../src/adapters/store.ts";
import type { AuditRecord } from "../src/audit/audit-log.ts";
import { ADAPTERS } from "./_adapters.ts";
import { TENANT, TEST_MS, cartContext, publish, publishUnchecked, simpleDraft, unwrap } from "./_helpers.ts";

const at = (ms: number) => instant("earth.unix.ms", BigInt(ms));

async function setup(adapterIndex = 0, atMs = TEST_MS) {
  const anchor = new MemoryAuditAnchor();
  const telemetry = new MemoryTelemetry({ stopwatch: fixedStopwatch() });
  const store = ADAPTERS[adapterIndex]!.create();
  const platform = new GoipPlatform({
    clock: fixedClock(BigInt(atMs) * 1_000_000n),
    ids: sequentialIdFactory(),
    store,
    telemetry,
    anchor,
    metricReader: telemetry,
  });
  unwrap(
    await platform.capabilities.fund({
      tenant: TENANT, actor: "t", sourceId: "merchant-1", label: "Budget",
      party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "10000.00",
    }),
  );
  return { platform, anchor, telemetry, store };
}

for (const [index, adapter] of ADAPTERS.entries()) {
  describe(`${adapter.name}: audit checkpointing`, () => {
    test("records a checkpoint and resumes from it", async () => {
      const { platform, store } = await setup(index);
      await publish(platform, simpleDraft());

      const first = unwrap(await platform.auditService.checkpoint(TENANT, at(TEST_MS)));
      assert.equal(first.fromSeq, 0, "the first run verifies from genesis");
      assert.equal(first.verified, 4);
      assert.equal(first.checkpoint.seq, 3);

      unwrap(await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

      const second = unwrap(await platform.auditService.checkpoint(TENANT, at(TEST_MS + 1000)));
      assert.equal(second.fromSeq, 4, "the second run resumes rather than re-walking history");
      assert.equal(second.verified, 2);

      const stored = unwrap(await store.audit.latestCheckpoint(TENANT));
      assert.equal(stored!.seq, 5);
      await store.close?.();
    });

    test("an empty chain cannot be checkpointed, and says so", async () => {
      const { platform, store } = await setup(index);
      const result = await platform.auditService.checkpoint("nobody", at(TEST_MS));
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.error.code, "NOT_FOUND");
      await store.close?.();
    });
  });

  describe(`${adapter.name}: external anchoring`, () => {
    test("publishes the head and reconciles against it", async () => {
      const { platform, store } = await setup(index);
      await publish(platform, simpleDraft());

      const published = unwrap(await platform.auditService.anchor(TENANT, "test", at(TEST_MS)));
      assert.equal(published.seq, 3);

      const reconciled = unwrap(await platform.auditService.reconcileWithAnchor(TENANT));
      assert.equal(reconciled.status, "matched");
      await store.close?.();
    });

    test("reports records written since the last anchor", async () => {
      const { platform, store } = await setup(index);
      await publish(platform, simpleDraft());
      unwrap(await platform.auditService.anchor(TENANT, "test", at(TEST_MS)));
      unwrap(await platform.capabilities.redeem({ context: cartContext(), actor: "t", idempotencyKey: "k" }));

      const reconciled = unwrap(await platform.auditService.reconcileWithAnchor(TENANT));
      assert.equal(reconciled.status, "ahead");
      assert.match(reconciled.detail, /2 record\(s\) are not yet anchored/);
      await store.close?.();
    });

    test("says plainly when nothing has been anchored yet", async () => {
      const { platform, store } = await setup(index);
      await publish(platform, simpleDraft());
      const reconciled = unwrap(await platform.auditService.reconcileWithAnchor(TENANT));
      assert.equal(reconciled.status, "no_anchor");
      assert.match(reconciled.detail, /would currently be undetectable/);
      await store.close?.();
    });
  });
}

/**
 * Rewrite detection is tested through a stub rather than a real adapter.
 *
 * Simulating an attacker means writing history that the port deliberately does
 * not allow - the audit store is append-only, and adding a `replaceAll` to it
 * so a test could call it would put a hole in the thing being protected. The
 * property under test lives in AuditService and is adapter-independent, so a
 * stub exercises it exactly.
 */
function stubAuditStore(records: AuditRecord[]) {
  return {
    audit: {
      async append() {
        throw new Error("not used");
      },
      async head() {
        return { ok: true as const, value: records[records.length - 1]?.hash ?? "" };
      },
      async headSeq() {
        return { ok: true as const, value: records.length - 1 };
      },
      async recent() {
        return { ok: true as const, value: records };
      },
      async at(_tenant: string, seq: number) {
        return { ok: true as const, value: records[seq] };
      },
      async verify() {
        const broken = findChainBreak(records);
        return broken
          ? { ok: false as const, error: { code: "CONFLICT" as const, message: "broken", details: { seq: broken.seq } } }
          : { ok: true as const, value: { records: records.length, head: records[records.length - 1]?.hash ?? "" } };
      },
      async saveCheckpoint(checkpoint: unknown) {
        return { ok: true as const, value: checkpoint };
      },
      async latestCheckpoint() {
        return { ok: true as const, value: undefined };
      },
    },
  } as unknown as PlatformStore;
}

function sealChain(payloads: readonly Record<string, unknown>[]): AuditRecord[] {
  const out: AuditRecord[] = [];
  let previousHash = GENESIS_HASH;
  for (const [seq, payload] of payloads.entries()) {
    const record = sealRecord(
      {
        tenant: TENANT,
        reality: "production",
        kind: "decision.made",
        subject: { kind: "decision", id: `d${seq}` },
        actor: "system",
        at: String(seq),
        payload: payload as never,
      },
      seq,
      previousHash,
    );
    out.push(record);
    previousHash = record.hash;
  }
  return out;
}

describe("rewrite detection", () => {
  const temporal = new TemporalAuthority({ clock: fixedClock(BigInt(TEST_MS) * 1_000_000n) });

  test("catches a consistent forgery that internal verification passes", async () => {
    const original = sealChain([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const anchor = new MemoryAuditAnchor();
    unwrap(await anchor.publish({ tenant: TENANT, seq: 2, hash: original[2]!.hash, at: "0" }));

    // Edit record 1 and re-seal everything after it, exactly as an attacker
    // with database access would. The result is a perfectly valid chain.
    const forged = sealChain([{ n: 1 }, { n: 999 }, { n: 3 }]);
    assert.equal(findChainBreak(forged), null, "the forgery is self-consistent");

    const service = new AuditService(stubAuditStore(forged), temporal, anchor);
    const reconciled = await service.reconcileWithAnchor(TENANT);

    assert.equal(reconciled.ok, false, "the anchor must catch what verification cannot");
    assert.equal(reconciled.ok === false && reconciled.error.code, "CONFLICT");
    assert.match(reconciled.ok === false ? reconciled.error.message : "", /rewritten/);
  });

  test("catches truncated history", async () => {
    const original = sealChain([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const anchor = new MemoryAuditAnchor();
    unwrap(await anchor.publish({ tenant: TENANT, seq: 2, hash: original[2]!.hash, at: "0" }));

    const service = new AuditService(stubAuditStore(original.slice(0, 2)), temporal, anchor);
    const reconciled = await service.reconcileWithAnchor(TENANT);

    assert.equal(reconciled.ok, false);
    assert.match(reconciled.ok === false ? reconciled.error.message : "", /truncated/);
  });

  test("an unmodified chain reconciles cleanly", async () => {
    const records = sealChain([{ n: 1 }, { n: 2 }]);
    const anchor = new MemoryAuditAnchor();
    unwrap(await anchor.publish({ tenant: TENANT, seq: 1, hash: records[1]!.hash, at: "0" }));

    const service = new AuditService(stubAuditStore(records), temporal, anchor);
    assert.equal(unwrap(await service.reconcileWithAnchor(TENANT)).status, "matched");
  });
});

describe("the anchor itself", () => {
  test("refuses to move backwards", async () => {
    const anchor = new MemoryAuditAnchor();
    unwrap(await anchor.publish({ tenant: "t", seq: 10, hash: "a", at: "1" }));
    const backwards = await anchor.publish({ tenant: "t", seq: 5, hash: "b", at: "2" });
    assert.equal(backwards.ok, false);
    assert.equal(backwards.ok === false && backwards.error.code, "ILLEGAL_STATE");
  });

  test("covering() finds the newest anchor at or below a sequence", async () => {
    const anchor = new MemoryAuditAnchor();
    for (const seq of [0, 5, 10]) unwrap(await anchor.publish({ tenant: "t", seq, hash: `h${seq}`, at: "1" }));
    assert.equal(unwrap(await anchor.covering("t", 7))!.seq, 5);
    assert.equal(unwrap(await anchor.covering("t", 10))!.seq, 10);
    assert.equal(unwrap(await anchor.covering("t", 100))!.seq, 10);
  });

  test("the file anchor appends and never rewrites", async () => {
    let contents = "";
    const fs: AnchorFileSystem = {
      appendFileSync: (_path, data) => {
        contents += data;
      },
      readFileSync: () => contents,
      existsSync: () => contents.length > 0,
    };
    const anchor = new FileAuditAnchor("/anchor.jsonl", fs);
    unwrap(await anchor.publish({ tenant: "t", seq: 1, hash: "a", at: "1" }));
    unwrap(await anchor.publish({ tenant: "t", seq: 2, hash: "b", at: "2" }));

    assert.equal(contents.trim().split("\n").length, 2);
    assert.equal(unwrap(await anchor.latest("t"))!.seq, 2);
    assert.equal(unwrap(await anchor.latest("other")), undefined);
  });
});

describe("maintenance runner", () => {
  test("runs every job on the first pass", async () => {
    const { platform, store } = await setup(0);
    await publish(platform, simpleDraft());

    const report = unwrap(await platform.maintenance.runDue(TENANT, at(TEST_MS)));
    assert.equal(report.failed, 0);
    assert.equal(report.ran, platform.maintenance.jobs.size);
    assert.deepEqual(
      report.jobs.map((j) => j.job).sort(),
      ["audit.anchor", "audit.checkpoint", "audit.reconcile", "health.check", "reservations.sweep"],
    );
    await store.close?.();
  });

  test("respects each job's interval on later passes", async () => {
    const { platform, store } = await setup(0);
    await publish(platform, simpleDraft());
    unwrap(await platform.maintenance.runDue(TENANT, at(TEST_MS)));

    // 90 seconds later: only the 60s health check is due.
    const second = unwrap(await platform.maintenance.runDue(TENANT, at(TEST_MS + 90_000)));
    const ran = second.jobs.filter((j) => j.status === "ran").map((j) => j.job);
    assert.deepEqual(ran, ["health.check"]);
    assert.ok(second.jobs.some((j) => j.job === "reservations.sweep" && j.status === "not_due"));
    await store.close?.();
  });

  test("runAll forces every job regardless of interval", async () => {
    const { platform, store } = await setup(0);
    await publish(platform, simpleDraft());
    unwrap(await platform.maintenance.runDue(TENANT, at(TEST_MS)));

    const forced = unwrap(await platform.maintenance.runAll(TENANT, at(TEST_MS + 1000)));
    assert.equal(forced.jobs.filter((j) => j.status === "not_due").length, 0);
    await store.close?.();
  });

  test("the sweep releases stale reservations and the health check clears", async () => {
    const { platform, store } = await setup(0);
    await publish(platform, simpleDraft());
    unwrap(await platform.capabilities.reserve({ context: cartContext(), actor: "t", idempotencyKey: "abandoned" }));

    const twoHoursLater = at(TEST_MS + 7200 * 1000);
    const report = unwrap(await platform.maintenance.runDue(TENANT, twoHoursLater));

    const sweep = report.jobs.find((j) => j.job === "reservations.sweep")!;
    assert.match(sweep.summary, /released 1 stale reservation/);
    assert.equal(report.health!.status, "healthy", "with the reservation released, health recovers");
    assert.deepEqual(report.alerts, []);
    await store.close?.();
  });

  test("optional jobs are skipped, not failed, when no anchor is configured", async () => {
    const platform = new GoipPlatform({
      clock: fixedClock(BigInt(TEST_MS) * 1_000_000n),
      ids: sequentialIdFactory(),
    });
    unwrap(
      await platform.capabilities.fund({
        tenant: TENANT, actor: "t", sourceId: "merchant-1", label: "B",
        party: { kind: "merchant", id: "m1" }, unit: "USD", budgetDecimal: "100.00",
      }),
    );
    await publish(platform, simpleDraft());

    const report = unwrap(await platform.maintenance.runDue(TENANT, at(TEST_MS)));
    assert.equal(report.failed, 0, "no anchor is a deployment choice, not an incident");
    const anchorJob = report.jobs.find((j) => j.job === "audit.anchor")!;
    assert.equal(anchorJob.status, "skipped");
  });

  test("surfaces alerts alongside the job results", async () => {
    const { platform, store, telemetry } = await setup(0);
    const broken = await publishUnchecked(
      platform,
      simpleDraft({ conditions: { op: "gt", left: { path: "subject.id" }, right: { literal: 5 } } }),
    );
    await platform.capabilities.apply({ context: cartContext(), candidateIds: [broken.id] });

    const report = unwrap(await platform.maintenance.runDue(TENANT, at(TEST_MS)));
    assert.ok(report.alerts.some((a) => a.rule === "rules.broken" && a.severity === "page"));
    assert.ok(telemetry.events({ severity: "error" }).some((e) => e.name.startsWith("goip.alert.")));
    await store.close?.();
  });
});
