/**
 * Audit maintenance.
 *
 * Three operations an operator runs on a schedule:
 *
 *   checkpoint  - verify forward and record how far we trust
 *   anchor      - publish the head hash somewhere we do not control
 *   reconcile   - compare the chain against the anchor
 *
 * The third is the one that matters. Verification alone only proves the chain
 * is internally consistent, which a wholesale rewrite also is. Comparing
 * against an independently held hash is what turns "tamper-evident" from a
 * slogan into a property.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { Instant } from "../universal/temporal/chronology.ts";
import type { AuditCheckpoint, PlatformStore } from "../adapters/store.ts";
import type { TemporalAuthority } from "../universal/temporal/authority.ts";
import type { AnchorRecord, AuditAnchor } from "./anchor.ts";

export interface CheckpointResult {
  readonly checkpoint: AuditCheckpoint;
  /** Records verified by this run, i.e. since the previous checkpoint. */
  readonly verified: number;
  /** Where verification resumed from. */
  readonly fromSeq: number;
}

export interface ReconcileResult {
  readonly status: "matched" | "no_anchor" | "ahead";
  readonly anchoredSeq?: number;
  readonly headSeq: number;
  readonly detail: string;
}

export class AuditService {
  readonly #store: PlatformStore;
  readonly #temporal: TemporalAuthority;
  readonly #anchor?: AuditAnchor;

  constructor(store: PlatformStore, temporal: TemporalAuthority, anchor?: AuditAnchor) {
    this.#store = store;
    this.#temporal = temporal;
    this.#anchor = anchor;
  }

  get hasAnchor(): boolean {
    return this.#anchor !== undefined;
  }

  /**
   * Verify forward from the last checkpoint and record a new one.
   *
   * Verifying from genesis is O(n) and stops scaling well before a year of
   * production. A checkpoint says "everything up to seq N was verified at time
   * T", so each run only walks what is new.
   */
  async checkpoint(tenant: string, now?: Instant): Promise<Result<CheckpointResult>> {
    const at = now ? ok(now) : this.#temporal.now();
    if (!at.ok) return at;

    const previous = await this.#store.audit.latestCheckpoint(tenant);
    if (!previous.ok) return previous;
    const fromSeq = previous.value ? previous.value.seq + 1 : 0;

    const verified = await this.#store.audit.verify(tenant, fromSeq);
    if (!verified.ok) return verified;

    const headSeq = await this.#store.audit.headSeq(tenant);
    if (!headSeq.ok) return headSeq;

    if (headSeq.value < 0) {
      return fail(ErrorCode.NOT_FOUND, `tenant '${tenant}' has no audit records to checkpoint`, { tenant });
    }

    const head = await this.#store.audit.head(tenant);
    if (!head.ok) return head;

    const checkpoint: AuditCheckpoint = {
      tenant,
      seq: headSeq.value,
      hash: head.value,
      at: at.value.tick.toString(),
    };
    const saved = await this.#store.audit.saveCheckpoint(checkpoint);
    if (!saved.ok) return saved;

    return ok({ checkpoint, verified: headSeq.value - fromSeq + 1, fromSeq });
  }

  /** Publish the current head to the external anchor. */
  async anchor(tenant: string, publishedBy = "system", now?: Instant): Promise<Result<AnchorRecord>> {
    if (!this.#anchor) {
      return fail(ErrorCode.NOT_IMPLEMENTED, "no audit anchor is configured", { tenant });
    }
    const at = now ? ok(now) : this.#temporal.now();
    if (!at.ok) return at;

    const headSeq = await this.#store.audit.headSeq(tenant);
    if (!headSeq.ok) return headSeq;
    if (headSeq.value < 0) {
      return fail(ErrorCode.NOT_FOUND, `tenant '${tenant}' has no audit records to anchor`, { tenant });
    }

    const head = await this.#store.audit.head(tenant);
    if (!head.ok) return head;

    return this.#anchor.publish({
      tenant,
      seq: headSeq.value,
      hash: head.value,
      at: at.value.tick.toString(),
      publishedBy,
    });
  }

  /**
   * Compare the chain against the anchor.
   *
   * A rewritten chain verifies internally - that is the whole problem - but the
   * record at the anchored sequence will no longer hash to the anchored value.
   * A mismatch here is a security incident, not a bug, so it is reported as
   * CONFLICT with both hashes attached.
   */
  async reconcileWithAnchor(tenant: string): Promise<Result<ReconcileResult>> {
    if (!this.#anchor) {
      return fail(ErrorCode.NOT_IMPLEMENTED, "no audit anchor is configured", { tenant });
    }

    const headSeq = await this.#store.audit.headSeq(tenant);
    if (!headSeq.ok) return headSeq;

    const anchored = await this.#anchor.latest(tenant);
    if (!anchored.ok) return anchored;

    if (!anchored.value) {
      return ok({
        status: "no_anchor",
        headSeq: headSeq.value,
        detail: "nothing has been anchored yet; a rewrite would currently be undetectable",
      });
    }

    const record = await this.#store.audit.at(tenant, anchored.value.seq);
    if (!record.ok) return record;

    if (!record.value) {
      return fail(
        ErrorCode.CONFLICT,
        `audit record ${anchored.value.seq} is anchored but missing from the chain; history has been truncated`,
        { tenant, anchoredSeq: anchored.value.seq, headSeq: headSeq.value },
      );
    }

    if (record.value.hash !== anchored.value.hash) {
      return fail(
        ErrorCode.CONFLICT,
        `audit record ${anchored.value.seq} does not match the anchor; the chain has been rewritten`,
        {
          tenant,
          seq: anchored.value.seq,
          anchoredHash: anchored.value.hash,
          chainHash: record.value.hash,
        },
      );
    }

    return ok({
      status: headSeq.value > anchored.value.seq ? "ahead" : "matched",
      anchoredSeq: anchored.value.seq,
      headSeq: headSeq.value,
      detail:
        headSeq.value > anchored.value.seq
          ? `chain matches the anchor at seq ${anchored.value.seq}; ${headSeq.value - anchored.value.seq} record(s) are not yet anchored`
          : `chain matches the anchor at seq ${anchored.value.seq}`,
    });
  }
}
