/**
 * External anchoring.
 *
 * The audit chain is tamper-*evident*: editing a record invalidates every hash
 * after it. It is not tamper-*proof*. Anyone who can rewrite the whole chain can
 * forge it consistently, and `verify()` will happily pass.
 *
 * Anchoring closes that. Publish the head hash periodically to a store held
 * under *different credentials*, then compare. A wholesale rewrite changes the
 * chain but cannot change the anchor, so the two disagree and the rewrite is
 * detectable.
 *
 * The port is deliberately tiny, because a real anchor is somebody else's
 * system: an append-only bucket with a separate IAM role, a partner's service,
 * a notarisation provider, another tenant's database. The two implementations
 * here are for tests and for a single-host deployment respectively; neither
 * gives the credential separation that makes anchoring worth doing, and both
 * say so.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";

export interface AnchorRecord {
  readonly tenant: string;
  readonly seq: number;
  readonly hash: string;
  /** Instant tick, as a string. */
  readonly at: string;
  /** Who published it. */
  readonly publishedBy?: string;
}

export interface AuditAnchor {
  publish(record: AnchorRecord): Promise<Result<AnchorRecord>>;
  latest(tenant: string): Promise<Result<AnchorRecord | undefined>>;
  /** The anchor covering a sequence number, i.e. the newest one at or below it. */
  covering(tenant: string, seq: number): Promise<Result<AnchorRecord | undefined>>;
}

/**
 * In-memory anchor. For tests only.
 *
 * It shares a process with the chain it anchors, so it provides no protection
 * whatsoever against an attacker who has that process. It exists to exercise
 * the comparison logic.
 */
export class MemoryAuditAnchor implements AuditAnchor {
  readonly #records = new Map<string, AnchorRecord[]>();

  async publish(record: AnchorRecord): Promise<Result<AnchorRecord>> {
    const list = this.#records.get(record.tenant) ?? [];
    const last = list[list.length - 1];
    if (last && record.seq < last.seq) {
      return fail(ErrorCode.ILLEGAL_STATE, `anchor for '${record.tenant}' would move backwards from seq ${last.seq} to ${record.seq}`, {
        currentSeq: last.seq,
        proposedSeq: record.seq,
      });
    }
    list.push(record);
    this.#records.set(record.tenant, list);
    return ok(record);
  }

  async latest(tenant: string): Promise<Result<AnchorRecord | undefined>> {
    const list = this.#records.get(tenant) ?? [];
    return ok(list[list.length - 1]);
  }

  async covering(tenant: string, seq: number): Promise<Result<AnchorRecord | undefined>> {
    const list = this.#records.get(tenant) ?? [];
    let best: AnchorRecord | undefined;
    for (const record of list) {
      if (record.seq <= seq && (!best || record.seq > best.seq)) best = record;
    }
    return ok(best);
  }

  /** Test affordance: corrupt the anchor, to prove the comparison catches it. */
  tamper(tenant: string, hash: string): void {
    const list = this.#records.get(tenant);
    const last = list?.[list.length - 1];
    if (last) list![list!.length - 1] = { ...last, hash };
  }
}

/**
 * Append-only file anchor.
 *
 * One JSON object per line. Useful for a single-host deployment where the file
 * can be owned by a different user and made append-only at the filesystem level
 * (`chattr +a` on Linux). That is weaker than a separate service but much
 * stronger than nothing, because the platform's own credentials cannot rewrite
 * history.
 */
/** The slice of a filesystem this anchor needs. Injected, so it is testable. */
export interface AnchorFileSystem {
  appendFileSync(path: string, data: string): void;
  readFileSync(path: string, encoding: "utf8"): string;
  existsSync(path: string): boolean;
}

export class FileAuditAnchor implements AuditAnchor {
  readonly #path: string;
  readonly #fs: AnchorFileSystem;

  constructor(path: string, fs: AnchorFileSystem) {
    this.#path = path;
    this.#fs = fs;
  }

  #read(tenant: string): AnchorRecord[] {
    if (!this.#fs.existsSync(this.#path)) return [];
    return this.#fs
      .readFileSync(this.#path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AnchorRecord)
      .filter((record) => record.tenant === tenant);
  }

  async publish(record: AnchorRecord): Promise<Result<AnchorRecord>> {
    const existing = this.#read(record.tenant);
    const last = existing[existing.length - 1];
    if (last && record.seq < last.seq) {
      return fail(ErrorCode.ILLEGAL_STATE, `anchor for '${record.tenant}' would move backwards`, {
        currentSeq: last.seq,
        proposedSeq: record.seq,
      });
    }
    this.#fs.appendFileSync(this.#path, `${JSON.stringify(record)}\n`);
    return ok(record);
  }

  async latest(tenant: string): Promise<Result<AnchorRecord | undefined>> {
    const records = this.#read(tenant);
    return ok(records[records.length - 1]);
  }

  async covering(tenant: string, seq: number): Promise<Result<AnchorRecord | undefined>> {
    let best: AnchorRecord | undefined;
    for (const record of this.#read(tenant)) {
      if (record.seq <= seq && (!best || record.seq > best.seq)) best = record;
    }
    return ok(best);
  }
}
