/**
 * Capability descriptors.
 *
 * The twenty-two verbs from the specification, as data. They exist so the
 * platform can enumerate and document its own surface, and so governance can
 * grant or withhold capabilities per tenant without knowing what any of them do.
 */
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";

export interface CapabilityDescriptor extends RegistryEntry {
  /** Which part of the pipeline this verb belongs to. */
  readonly phase: "author" | "distribute" | "decide" | "execute" | "settle" | "observe";
  /** Does invoking it change stored state? */
  readonly mutating: boolean;
  /** Does it move or commit value? These are the ones worth alerting on. */
  readonly financial: boolean;
}

const d = (
  key: string,
  label: string,
  phase: CapabilityDescriptor["phase"],
  mutating: boolean,
  financial: boolean,
  description: string,
): CapabilityDescriptor => ({ key, label, phase, mutating, financial, description });

export const CAPABILITIES: CapabilityDescriptor[] = [
  d("create", "Create Value Exchange", "author", true, false, "Author a new value exchange in draft state."),
  d("clone", "Clone Value Exchange", "author", true, false, "Copy an existing exchange into a fresh draft."),
  d("publish", "Publish Value Exchange", "author", true, false, "Move an exchange to active after policy review."),
  d("govern", "Govern Value Exchange", "author", true, false, "Run policy review, or move an exchange through its lifecycle."),
  d("validate", "Validate Value Exchange", "author", false, false, "Check an exchange against policy without changing it."),

  d("discover", "Discover Value Exchange", "distribute", false, false, "What is available to this subject, here, now."),
  d("search", "Search Value Exchange", "distribute", false, false, "Discovery narrowed by text or profile."),
  d("compare", "Compare Value Exchange", "distribute", false, false, "Evaluate the same context under several objectives."),
  d("issue", "Issue Value Exchange", "distribute", true, false, "Grant an exchange to a named subject."),
  d("activate", "Activate Value Exchange", "distribute", true, false, "Turn an issued grant into a usable one."),

  d("apply", "Apply Value Exchange", "decide", false, false, "Quote: what would this subject get for this basket."),
  d("optimize", "Optimize Value Exchange", "decide", false, false, "Apply under a named objective."),
  d("simulate", "Simulate Value Exchange", "decide", false, false, "Run a decision in a non-binding reality."),
  d("forecast", "Forecast Value Exchange", "decide", false, false, "Project budget burn from current consumption."),

  d("reserve", "Reserve Value Exchange", "execute", true, true, "Hold budget and consume limits without paying."),
  d("redeem", "Redeem Value Exchange", "execute", true, true, "Reserve and capture in one step."),
  d("track", "Track Value Exchange", "observe", true, false, "Record a touchpoint in an attribution journey."),
  d("attribute", "Attribute Value Exchange", "observe", false, false, "Divide credit across a journey."),

  d("fund", "Fund Value Exchange", "settle", true, true, "Create or top up a funding source."),
  d("settle", "Settle Value Exchange", "settle", false, true, "Net the ledger into per-account positions."),
  d("pay", "Pay Value Exchange", "settle", true, true, "Move an owed balance off the platform."),
  d("audit", "Audit Value Exchange", "observe", false, false, "Verify the audit chain and read its records."),
];

export function capabilityRegistry(): Registry<CapabilityDescriptor> {
  return new Registry<CapabilityDescriptor>("capability").registerAll(CAPABILITIES);
}
