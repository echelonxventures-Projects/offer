/**
 * The incentive graph, projected.
 *
 * [docs/01-architecture/06-incentive-graph.md] describes the platform as
 * graph-native and is precise about what that means: the graph is a **derived
 * view** over stored records, never a second source of truth. Until now the
 * design guaranteed that every edge was derivable and shipped no projector, on
 * the grounds that building one meant inventing a query interface nobody had
 * specified.
 *
 * This is that projector, and it stays inside the same discipline:
 *
 *  - **Derived, never stored.** Nothing here writes. Delete a projection and
 *    the next one is identical.
 *  - **Never on the decision path.** A decision walks a fixed pipeline. If an
 *    eligibility rule needs a graph-derived fact, that fact is computed here,
 *    upstream, and placed in the context as a facet or a counter. A decision
 *    whose latency depends on how much history a subject has is not one you
 *    can operate.
 *  - **Bounded, and honest about it.** Phase 5's lesson was that a read which
 *    folds an append-only table from genesis gets slower forever. A projection
 *    is inherently a scan, so it takes an explicit budget, stops when it hits
 *    it, and says so rather than quietly returning a partial graph.
 *
 * The spine is the audit chain, because the chain is what actually records
 * what happened - which also means a projection inherits the chain's tamper
 * evidence. Records the platform never writes cannot appear here: a quote that
 * was never reserved leaves no trace, by design, since a price somebody was
 * shown and did not take is not a material event.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { Json, JsonObject } from "../kernel/types.ts";
import type { PlatformStore } from "../adapters/store.ts";
import type { AuditRecord } from "../audit/audit-log.ts";
import { compareKeys } from "../kernel/order.ts";

/** How many audit records a projection reads per page. */
export const PROJECTION_PAGE = 1_000;

export interface GraphNode {
  /** Namespaced so two kinds can never collide: `vx:...`, `sub:...`. */
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly attributes: JsonObject;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly attributes?: JsonObject;
}

export interface ProjectionRequest {
  readonly tenant: string;
  /**
   * Maximum audit records to read. The projection stops here and reports
   * `truncated`, rather than growing without limit on a busy tenant.
   */
  readonly maxAuditRecords?: number;
  /** Start from this sequence. Lets a caller project a window of history. */
  readonly fromSeq?: number;
  /** Include Account nodes and POSTED_TO edges. Costs a ledger scan. */
  readonly includeLedger?: boolean;
  readonly maxLedgerEntries?: number;
}

export interface Projection {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** What it cost, reported rather than assumed. */
  readonly scanned: {
    readonly auditRecords: number;
    readonly exchanges: number;
    readonly fundingSources: number;
    readonly ledgerEntries: number;
  };
  /** Highest audit sequence included. */
  readonly throughSeq: number;
  /** True when a budget was reached and history is missing from the result. */
  readonly truncated: boolean;
}

/* ------------------------------------------------------------------ *
 * Node identity
 * ------------------------------------------------------------------ */

export const nodeId = {
  exchange: (id: string) => `vx:${id}`,
  grant: (id: string) => `grn:${id}`,
  subject: (id: string) => `sub:${id}`,
  execution: (id: string) => `exe:${id}`,
  decision: (id: string) => `dec:${id}`,
  funding: (id: string) => `fnd:${id}`,
  party: (kind: string, id: string) => `pty:${kind}:${id}`,
  account: (id: string) => `acc:${id}`,
  touchpoint: (id: string) => `tp:${id}`,
  spatial: (key: string) => `spn:${key}`,
  unit: (key: string) => `unit:${key}`,
  reality: (key: string) => `rlt:${key}`,
};

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

export class GraphProjector {
  readonly #store: PlatformStore;

  constructor(store: PlatformStore) {
    this.#store = store;
  }

  async project(request: ProjectionRequest): Promise<Result<Projection>> {
    const { tenant } = request;
    const budget = request.maxAuditRecords ?? 10_000;

    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();

    const addNode = (node: GraphNode) => {
      // First writer wins on label, but attributes merge, because a subject
      // seen first in a touchpoint and later in an execution is one subject.
      const existing = nodes.get(node.id);
      if (existing === undefined) nodes.set(node.id, node);
      else nodes.set(node.id, { ...existing, attributes: { ...existing.attributes, ...node.attributes } });
    };
    const addEdge = (edge: GraphEdge) => {
      edges.set(`${edge.kind}|${edge.from}|${edge.to}`, edge);
    };

    /* -- Value exchanges, and everything derivable from their fields -- */
    const exchanges = await this.#store.exchanges.find(tenant);
    if (!exchanges.ok) return exchanges;

    for (const exchange of exchanges.value) {
      addNode({
        id: nodeId.exchange(exchange.id),
        kind: "ValueExchange",
        label: exchange.name,
        attributes: {
          profile: exchange.profile,
          state: exchange.state,
          version: exchange.version,
          priority: exchange.priority,
          visibility: exchange.visibility,
        },
      });

      for (const split of exchange.funding.splits) {
        addEdge({ from: nodeId.exchange(exchange.id), to: nodeId.funding(split.sourceId), kind: "FUNDED_BY" });
      }
      for (const place of exchange.scope.spatial?.include ?? []) {
        addNode({ id: nodeId.spatial(place), kind: "SpatialNode", label: place, attributes: {} });
        addEdge({ from: nodeId.exchange(exchange.id), to: nodeId.spatial(place), kind: "SCOPED_TO" });
      }
      for (const benefit of exchange.benefits) {
        if (benefit.unit === undefined) continue;
        addNode({ id: nodeId.unit(benefit.unit), kind: "EconomicUnit", label: benefit.unit, attributes: {} });
        addEdge({
          from: nodeId.exchange(exchange.id),
          to: nodeId.unit(benefit.unit),
          kind: "DENOMINATED_IN",
          attributes: { benefit: benefit.id },
        });
      }
      for (const reality of exchange.scope.realities ?? []) {
        addNode({ id: nodeId.reality(reality), kind: "Reality", label: reality, attributes: {} });
      }
    }

    /* -- Funding sources and the parties holding them -- */
    const sources = await this.#store.funding.list(tenant);
    if (!sources.ok) return sources;

    for (const source of sources.value) {
      addNode({
        id: nodeId.funding(source.id),
        kind: "FundingSource",
        label: source.label,
        attributes: {
          unit: source.unit,
          spent: source.spent.minor.toString(),
          reserved: source.reserved.minor.toString(),
          // Absent means uncapped, which is a different thing from zero and
          // the graph should not flatten the two.
          ...(source.budget === undefined ? {} : { budget: source.budget.minor.toString() }),
        },
      });
      addNode({
        id: nodeId.party(source.party.kind, source.party.id),
        kind: "Party",
        label: `${source.party.kind}:${source.party.id}`,
        attributes: { kind: source.party.kind },
      });
      addEdge({
        from: nodeId.funding(source.id),
        to: nodeId.party(source.party.kind, source.party.id),
        kind: "HELD_BY",
      });
    }

    /* -- The audit chain: grants, decisions and executions -- */
    let scannedRecords = 0;
    let throughSeq = (request.fromSeq ?? 0) - 1;
    let truncated = false;
    let from = request.fromSeq ?? 0;

    for (;;) {
      const remaining = budget - scannedRecords;
      if (remaining <= 0) {
        // Only truncated if there was in fact more to read.
        const more = await this.#store.audit.range(tenant, from, 1);
        if (!more.ok) return more;
        truncated = more.value.length > 0;
        break;
      }
      const page = await this.#store.audit.range(tenant, from, Math.min(PROJECTION_PAGE, remaining));
      if (!page.ok) return page;
      if (page.value.length === 0) break;

      for (const record of page.value) {
        scannedRecords += 1;
        throughSeq = record.seq;
        this.#applyRecord(record, addNode, addEdge);
      }
      from = (page.value[page.value.length - 1] as AuditRecord).seq + 1;
    }

    /* -- Accounts, when asked for -- */
    let scannedEntries = 0;
    if (request.includeLedger === true) {
      const limit = request.maxLedgerEntries ?? 10_000;
      const entries = await this.#store.ledger.entriesSince(tenant, -1, limit);
      if (!entries.ok) return entries;
      scannedEntries = entries.value.entries.length;
      if (scannedEntries >= limit) truncated = true;

      for (const entry of entries.value.entries) {
        addNode({
          id: nodeId.account(entry.accountId),
          kind: "Account",
          label: entry.accountId,
          attributes: { unit: entry.amount.unit },
        });
        if (entry.reference.kind === "execution") {
          addEdge({
            from: nodeId.execution(entry.reference.id),
            to: nodeId.account(entry.accountId),
            kind: "POSTED_TO",
            attributes: { direction: entry.direction },
          });
        }
      }
    }

    /* -- Touchpoints -- */
    const touchpoints = await this.#store.touchpoints.journey({ tenant, limit: 5_000 });
    if (!touchpoints.ok) return touchpoints;

    for (const touchpoint of touchpoints.value) {
      addNode({
        id: nodeId.touchpoint(touchpoint.id),
        kind: "Touchpoint",
        label: touchpoint.kind,
        attributes: { at: touchpoint.at, ...(touchpoint.channel === undefined ? {} : { channel: touchpoint.channel }) },
      });
      addNode({
        id: nodeId.party(touchpoint.party.kind, touchpoint.party.id),
        kind: "Party",
        label: `${touchpoint.party.kind}:${touchpoint.party.id}`,
        attributes: { kind: touchpoint.party.kind },
      });
      addEdge({
        from: nodeId.touchpoint(touchpoint.id),
        to: nodeId.party(touchpoint.party.kind, touchpoint.party.id),
        kind: "CLAIMS",
      });
      if (touchpoint.subjectId !== undefined) {
        addNode({ id: nodeId.subject(touchpoint.subjectId), kind: "Subject", label: touchpoint.subjectId, attributes: {} });
        addEdge({ from: nodeId.touchpoint(touchpoint.id), to: nodeId.subject(touchpoint.subjectId), kind: "TOUCHED" });
      }
    }

    return ok({
      nodes: [...nodes.values()].sort((a, b) => compareKeys(a.id, b.id)),
      edges: [...edges.values()].sort(
        (a, b) => compareKeys(a.kind, b.kind) || compareKeys(a.from, b.from) || compareKeys(a.to, b.to),
      ),
      scanned: {
        auditRecords: scannedRecords,
        exchanges: exchanges.value.length,
        fundingSources: sources.value.length,
        ledgerEntries: scannedEntries,
      },
      throughSeq,
      truncated,
    });
  }

  #applyRecord(
    record: AuditRecord,
    addNode: (node: GraphNode) => void,
    addEdge: (edge: GraphEdge) => void,
  ): void {
    const payload = (record.payload ?? {}) as Record<string, Json>;
    const str = (key: string): string | undefined => {
      const value = payload[key];
      return typeof value === "string" ? value : undefined;
    };

    if (record.kind === "grant.issued") {
      const grantId = record.subject.id;
      const exchangeId = str("valueExchangeId");
      const subjectId = str("subjectId");
      addNode({ id: nodeId.grant(grantId), kind: "Grant", label: grantId, attributes: { at: record.at } });
      if (exchangeId !== undefined) {
        addEdge({ from: nodeId.grant(grantId), to: nodeId.exchange(exchangeId), kind: "INSTANCE_OF" });
      }
      if (subjectId !== undefined) {
        addNode({ id: nodeId.subject(subjectId), kind: "Subject", label: subjectId, attributes: {} });
        addEdge({ from: nodeId.grant(grantId), to: nodeId.subject(subjectId), kind: "ISSUED_TO" });
      }
      return;
    }

    if (record.kind === "execution.reserved") {
      const executionId = record.subject.id;
      const decisionId = str("decisionId");
      const subjectId = str("subjectId");

      addNode({
        id: nodeId.execution(executionId),
        kind: "Execution",
        label: executionId,
        attributes: { at: record.at, state: "reserved" },
      });
      if (decisionId !== undefined) {
        addNode({
          id: nodeId.decision(decisionId),
          kind: "Decision",
          label: decisionId,
          attributes: {
            at: record.at,
            ...(str("decisionHash") === undefined ? {} : { hash: str("decisionHash") as string }),
            ...(str("bundle") === undefined ? {} : { bundle: str("bundle") as string }),
          },
        });
        addEdge({ from: nodeId.execution(executionId), to: nodeId.decision(decisionId), kind: "EXECUTES" });
      }
      if (subjectId !== undefined) {
        addNode({ id: nodeId.subject(subjectId), kind: "Subject", label: subjectId, attributes: {} });
        addEdge({ from: nodeId.execution(executionId), to: nodeId.subject(subjectId), kind: "REDEEMED_BY" });
      }

      // DECIDED: which exchanges the decision actually applied. There is no
      // REJECTED edge, because rejections belong to the quote and the platform
      // does not record quotes - see the note on the reservation payload.
      const applied = payload.applied;
      if (Array.isArray(applied) && decisionId !== undefined) {
        for (const exchangeId of applied) {
          if (typeof exchangeId !== "string") continue;
          addEdge({ from: nodeId.decision(decisionId), to: nodeId.exchange(exchangeId), kind: "DECIDED" });
          addEdge({ from: nodeId.execution(executionId), to: nodeId.exchange(exchangeId), kind: "APPLIED" });
        }
      }
      return;
    }

    if (
      record.kind === "execution.captured" ||
      record.kind === "execution.released" ||
      record.kind === "execution.reversed"
    ) {
      const executionId = record.subject.id;
      const state = record.kind.slice("execution.".length);
      addNode({
        id: nodeId.execution(executionId),
        kind: "Execution",
        label: executionId,
        attributes: {
          state,
          // The reaper releases through the same path a customer cancellation
          // takes, so the actor is what distinguishes them. Recorded here
          // because "why was this released?" is a real question.
          [`${state}By`]: record.actor,
        },
      });
      return;
    }

    if (record.kind === "value_exchange.created" || record.kind === "value_exchange.transitioned") {
      addNode({
        id: nodeId.exchange(record.subject.id),
        kind: "ValueExchange",
        label: record.subject.id,
        attributes: {},
      });
    }
  }
}
