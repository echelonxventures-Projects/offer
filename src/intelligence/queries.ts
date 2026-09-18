/**
 * The questions the graph exists to answer.
 *
 * [docs/01-architecture/06-incentive-graph.md] lists six queries as "painful
 * without the graph and straightforward with it". They are implemented here,
 * by name, because a projector with no queries on top of it is a data structure
 * rather than an answer, and because naming them fixes what each one means.
 *
 * Every function is pure over a `Projection`. Nothing reads the store, so a
 * caller projects once and asks many questions, and none of this can affect a
 * decision even by accident.
 */
import type { Projection, GraphEdge, GraphNode } from "./graph.ts";
import { nodeId } from "./graph.ts";
import { compareKeys } from "../kernel/order.ts";

function edgesOfKind(projection: Projection, kind: string): readonly GraphEdge[] {
  return projection.edges.filter((edge) => edge.kind === kind);
}

function nodeOf(projection: Projection, id: string): GraphNode | undefined {
  return projection.nodes.find((node) => node.id === id);
}

/* ------------------------------------------------------------------ */

export interface SubjectHistory {
  readonly subjectId: string;
  readonly executions: readonly string[];
  readonly decisions: readonly string[];
  /** Exchanges that actually applied for this subject. */
  readonly applied: readonly string[];
  readonly grants: readonly string[];
  readonly touchpoints: readonly string[];
}

/** "Which offers did this customer see, take, and miss?" */
export function historyOfSubject(projection: Projection, subjectId: string): SubjectHistory {
  const subject = nodeId.subject(subjectId);

  const executions = edgesOfKind(projection, "REDEEMED_BY")
    .filter((edge) => edge.to === subject)
    .map((edge) => edge.from);

  const decisions = edgesOfKind(projection, "EXECUTES")
    .filter((edge) => executions.includes(edge.from))
    .map((edge) => edge.to);

  const applied = edgesOfKind(projection, "APPLIED")
    .filter((edge) => executions.includes(edge.from))
    .map((edge) => edge.to.slice("vx:".length));

  return {
    subjectId,
    applied: [...new Set(applied)].sort(compareKeys),
    executions: [...executions].sort(compareKeys),
    decisions: [...new Set(decisions)].sort(compareKeys),
    grants: edgesOfKind(projection, "ISSUED_TO")
      .filter((edge) => edge.to === subject)
      .map((edge) => edge.from)
      .sort(compareKeys),
    touchpoints: edgesOfKind(projection, "TOUCHED")
      .filter((edge) => edge.to === subject)
      .map((edge) => edge.from)
      .sort(compareKeys),
  };
}

/* ------------------------------------------------------------------ */

export interface FundingDependency {
  readonly fundingSourceId: string;
  readonly label: string;
  /** Exchanges that name this source. Retiring it stops every one of them. */
  readonly dependents: readonly { readonly id: string; readonly name: string; readonly state: string }[];
  /** Of those, the ones currently live. The number that matters. */
  readonly activeDependents: number;
}

/**
 * "If we retire this funding source, which offers stop working?"
 *
 * The single most useful pre-change safety query, and the reason
 * `funding.sources_exist` is a governance policy rather than a warning.
 */
export function dependentsOfFundingSource(projection: Projection, sourceId: string): FundingDependency {
  const target = nodeId.funding(sourceId);
  const dependents = edgesOfKind(projection, "FUNDED_BY")
    .filter((edge) => edge.to === target)
    .map((edge) => {
      const node = nodeOf(projection, edge.from);
      return {
        id: edge.from.slice("vx:".length),
        name: node?.label ?? edge.from,
        state: typeof node?.attributes.state === "string" ? node.attributes.state : "unknown",
      };
    })
    .sort((a, b) => compareKeys(a.id, b.id));

  return {
    fundingSourceId: sourceId,
    label: nodeOf(projection, target)?.label ?? sourceId,
    dependents,
    activeDependents: dependents.filter((d) => d.state === "active").length,
  };
}

/* ------------------------------------------------------------------ */

export interface CampaignCost {
  readonly valueExchangeId: string;
  readonly name: string;
  readonly executions: number;
  /** Funding sources that paid, and through them the parties that bore it. */
  readonly fundedBy: readonly { readonly sourceId: string; readonly party: string }[];
}

/** "What did this campaign actually cost, and who bore it?" */
export function costOfCampaign(projection: Projection, valueExchangeId: string): CampaignCost {
  const exchange = nodeId.exchange(valueExchangeId);

  const fundedBy = edgesOfKind(projection, "FUNDED_BY")
    .filter((edge) => edge.from === exchange)
    .map((edge) => {
      const held = edgesOfKind(projection, "HELD_BY").find((h) => h.from === edge.to);
      return {
        sourceId: edge.to.slice("fnd:".length),
        party: held === undefined ? "unknown" : held.to.slice("pty:".length),
      };
    })
    .sort((a, b) => compareKeys(a.sourceId, b.sourceId));

  return {
    valueExchangeId,
    name: nodeOf(projection, exchange)?.label ?? valueExchangeId,
    executions: edgesOfKind(projection, "APPLIED").filter((edge) => edge.to === exchange).length,
    fundedBy,
  };
}

/* ------------------------------------------------------------------ */

export interface PartyAttribution {
  readonly party: string;
  readonly touchpoints: number;
  readonly subjects: number;
}

/** "Which partner drove this?" — by touchpoint claim, before any weighting. */
export function claimsByParty(projection: Projection): readonly PartyAttribution[] {
  const byParty = new Map<string, { touchpoints: number; subjects: Set<string> }>();

  for (const claim of edgesOfKind(projection, "CLAIMS")) {
    const party = claim.to.slice("pty:".length);
    const entry = byParty.get(party) ?? { touchpoints: 0, subjects: new Set<string>() };
    entry.touchpoints += 1;
    for (const touched of edgesOfKind(projection, "TOUCHED")) {
      if (touched.from === claim.from) entry.subjects.add(touched.to);
    }
    byParty.set(party, entry);
  }

  return [...byParty.entries()]
    .map(([party, entry]) => ({ party, touchpoints: entry.touchpoints, subjects: entry.subjects.size }))
    .sort((a, b) => b.touchpoints - a.touchpoints || compareKeys(a.party, b.party));
}

/* ------------------------------------------------------------------ */

export interface NeverDelivered {
  readonly valueExchangeId: string;
  readonly name: string;
  readonly state: string;
}

/**
 * "Which live campaigns have never delivered anything?"
 *
 * The graph document calls the displacement version of this "one of the most
 * useful and least available reports in this domain". This is the blunter and
 * more actionable form: an exchange that is active, and that no execution in
 * the projected window ever touched.
 *
 * It is evidence, not proof. A campaign published this morning has not failed;
 * read it against the window the projection actually covers.
 */
export function neverDelivered(projection: Projection): readonly NeverDelivered[] {
  const delivered = new Set<string>();
  for (const edge of edgesOfKind(projection, "APPLIED")) delivered.add(edge.to);
  for (const edge of edgesOfKind(projection, "INSTANCE_OF")) delivered.add(edge.to);

  return projection.nodes
    .filter((node) => node.kind === "ValueExchange")
    .filter((node) => node.attributes.state === "active")
    .filter((node) => !delivered.has(node.id))
    .map((node) => ({
      valueExchangeId: node.id.slice("vx:".length),
      name: node.label,
      state: String(node.attributes.state),
    }))
    .sort((a, b) => compareKeys(a.valueExchangeId, b.valueExchangeId));
}

/* ------------------------------------------------------------------ */

export interface GraphSummary {
  readonly nodesByKind: Readonly<Record<string, number>>;
  readonly edgesByKind: Readonly<Record<string, number>>;
  readonly orphans: readonly string[];
}

/** Shape of the projection, and anything in it nothing connects to. */
export function summarise(projection: Projection): GraphSummary {
  const nodesByKind: Record<string, number> = {};
  const edgesByKind: Record<string, number> = {};
  const connected = new Set<string>();

  for (const node of projection.nodes) nodesByKind[node.kind] = (nodesByKind[node.kind] ?? 0) + 1;
  for (const edge of projection.edges) {
    edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
    connected.add(edge.from);
    connected.add(edge.to);
  }

  return {
    nodesByKind,
    edgesByKind,
    orphans: projection.nodes
      .filter((node) => !connected.has(node.id))
      .map((node) => node.id)
      .sort(compareKeys),
  };
}
