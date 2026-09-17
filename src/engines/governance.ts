/**
 * Governance Engine.
 *
 * Policies are checks on a value exchange *as authored*, run before it may go
 * live - not on the traffic it later sees. They are the difference between a
 * platform and a liability: "every exchange must name a funder", "a public
 * offer must have an end date", "a commission must be payable in a
 * transferable unit".
 *
 * Policies are registry entries with parameters in their metadata, so a tenant
 * tightens a threshold by editing data rather than by shipping code.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { RegistryEntry, Registry } from "../registry/registry.ts";
import { Registry as RegistryClass } from "../registry/registry.ts";
import type { ValueExchange } from "../model/value-exchange.ts";
import type { LifecycleState } from "../model/lifecycle.ts";
import { canTransition } from "../model/lifecycle.ts";
import type { EngineDeps } from "./deps.ts";

export type PolicySeverity = "error" | "warning";

export interface PolicyViolation {
  readonly policy: string;
  readonly severity: PolicySeverity;
  readonly message: string;
  readonly path?: string;
}

export interface PolicyContext {
  readonly exchange: ValueExchange;
  readonly deps: EngineDeps;
}

export interface Policy extends RegistryEntry {
  readonly severity: PolicySeverity;
  /** Profiles this applies to. Empty means all. */
  readonly profiles?: readonly string[];
  check(context: PolicyContext): Promise<Result<PolicyViolation[]>> | Result<PolicyViolation[]>;
}

export interface PolicyReport {
  readonly valueExchangeId: string;
  readonly passed: boolean;
  readonly violations: readonly PolicyViolation[];
  readonly policiesRun: number;
}

const violation = (
  policy: string,
  severity: PolicySeverity,
  message: string,
  path?: string,
): PolicyViolation => (path === undefined ? { policy, severity, message } : { policy, severity, message, path });

export const DEFAULT_POLICIES: Policy[] = [
  {
    key: "funding.declared",
    label: "Funding must be declared",
    description: "Every benefit costs somebody something; an exchange with no funder cannot be settled.",
    severity: "error",
    check({ exchange }) {
      return ok(
        exchange.funding.splits.length === 0
          ? [violation("funding.declared", "error", "no funding sources declared", "funding.splits")]
          : [],
      );
    },
  },
  {
    key: "funding.sources_exist",
    label: "Funding sources must exist",
    severity: "error",
    async check({ exchange, deps }) {
      const violations: PolicyViolation[] = [];
      for (const split of exchange.funding.splits) {
        const source = await deps.store.funding.get(exchange.tenant, split.sourceId);
        if (!source.ok) {
          violations.push(
            violation("funding.sources_exist", "error", `funding source '${split.sourceId}' does not exist`, "funding.splits"),
          );
        }
      }
      return ok(violations);
    },
  },
  {
    key: "budget.bounded",
    label: "Exposure must be bounded",
    description: "An exchange needs either a total budget, a redemption cap, or a funder with a capped budget.",
    severity: "warning",
    async check({ exchange, deps }) {
      if (exchange.limits.totalBudget || exchange.limits.totalRedemptions !== undefined) return ok([]);
      let anyCapped = false;
      for (const split of exchange.funding.splits) {
        const source = await deps.store.funding.get(exchange.tenant, split.sourceId);
        if (source.ok && source.value.budget !== undefined) anyCapped = true;
      }
      return ok(
        anyCapped
          ? []
          : [violation("budget.bounded", "warning", "exposure is unbounded: no budget, no redemption cap, no capped funder", "limits")],
      );
    },
  },
  {
    key: "public.has_window",
    label: "Public offers need an end",
    severity: "warning",
    check({ exchange }) {
      if (exchange.visibility !== "public") return ok([]);
      return ok(
        exchange.window?.to
          ? []
          : [violation("public.has_window", "warning", "a public offer with no end date runs forever", "window.to")],
      );
    },
  },
  {
    key: "owner.named",
    label: "An accountable owner must be named",
    severity: "warning",
    check({ exchange }) {
      return ok(
        exchange.governance.owner
          ? []
          : [violation("owner.named", "warning", "no accountable owner recorded", "governance.owner")],
      );
    },
  },
  {
    key: "benefit.types_registered",
    label: "Benefit types and effects must be registered",
    severity: "error",
    check({ exchange, deps }) {
      const violations: PolicyViolation[] = [];
      for (const benefit of exchange.benefits) {
        if (!deps.benefitTypes.has(benefit.type)) {
          violations.push(violation("benefit.types_registered", "error", `unknown benefit type '${benefit.type}'`, `benefits.${benefit.id}.type`));
        }
        if (!deps.effectKinds.has(benefit.effect)) {
          violations.push(violation("benefit.types_registered", "error", `unknown effect '${benefit.effect}'`, `benefits.${benefit.id}.effect`));
        }
      }
      return ok(violations);
    },
  },
  {
    key: "commission.payable_unit",
    label: "Commissions must be payable",
    description: "A commission credited in a non-transferable unit can never actually be paid out.",
    severity: "error",
    check({ exchange, deps }) {
      const violations: PolicyViolation[] = [];
      for (const benefit of exchange.benefits) {
        if (benefit.effect !== "commission") continue;
        const unit = benefit.unit;
        if (unit && !deps.economic.isTransferable(unit)) {
          violations.push(
            violation("commission.payable_unit", "error", `commission in '${unit}', which is not transferable`, `benefits.${benefit.id}.unit`),
          );
        }
      }
      return ok(violations);
    },
  },
  {
    key: "window.valid",
    label: "Window constraints must name real calendar fields",
    severity: "error",
    check({ exchange, deps }) {
      if (!exchange.window) return ok([]);
      const validated = deps.temporal.validateWindow(exchange.window);
      return ok(
        validated.ok ? [] : [violation("window.valid", "error", validated.error.message, "window.constraints")],
      );
    },
  },
];

export function policyRegistry(): Registry<Policy> {
  return new RegistryClass<Policy>("policy").registerAll(DEFAULT_POLICIES);
}

export class GovernanceEngine {
  readonly #deps: EngineDeps;
  readonly policies: Registry<Policy>;

  constructor(deps: EngineDeps, policies: Registry<Policy>) {
    this.#deps = deps;
    this.policies = policies;
  }

  /** Run every applicable policy. Warnings do not block; errors do. */
  async review(exchange: ValueExchange): Promise<Result<PolicyReport>> {
    const applicable = this.policies
      .list()
      .filter((p) => !p.profiles?.length || p.profiles.includes(exchange.profile));

    const violations: PolicyViolation[] = [];
    for (const policy of applicable) {
      const result = await policy.check({ exchange, deps: this.#deps });
      if (!result.ok) return result;
      violations.push(...result.value);
    }

    return ok({
      valueExchangeId: exchange.id,
      passed: !violations.some((v) => v.severity === "error"),
      violations,
      policiesRun: applicable.length,
    });
  }

  /**
   * Move an exchange through its lifecycle, enforcing both the transition table
   * and, for the edges that demand it, a recorded approval.
   */
  async transition(
    exchange: ValueExchange,
    to: LifecycleState,
    actor: string,
    at: string,
  ): Promise<Result<ValueExchange>> {
    const allowed = canTransition(this.#deps.lifecycle, exchange.state, to);
    if (!allowed.ok) return allowed;

    if (to === "active" || to === "approved") {
      const report = await this.review(exchange);
      if (!report.ok) return report;
      if (!report.value.passed) {
        return fail(ErrorCode.GOVERNANCE_REJECTED, `policy errors block the move to '${to}'`, {
          violations: report.value.violations.filter((v) => v.severity === "error"),
        });
      }
    }

    if (allowed.value.requiresApproval) {
      const approvals = exchange.governance.approvals ?? [];
      const approvedByAnother = approvals.some((a) => a.by !== exchange.createdBy);
      if (!approvedByAnother) {
        return fail(
          ErrorCode.GOVERNANCE_REJECTED,
          `'${exchange.state}' to '${to}' needs an approval from someone other than the author`,
          { transition: allowed.value.key, approvals: approvals.length },
        );
      }
    }

    const moved: ValueExchange = { ...exchange, state: to, updatedAt: at };
    const stored = await this.#deps.store.exchanges.put(moved);
    if (!stored.ok) return stored;

    const audited = await this.#deps.store.audit.append({
      tenant: exchange.tenant,
      reality: "production",
      kind: "value_exchange.transitioned",
      subject: { kind: "value_exchange", id: exchange.id },
      actor,
      at,
      payload: { from: exchange.state, to, transition: allowed.value.key },
    });
    if (!audited.ok) return audited;

    return ok(moved);
  }
}
