/**
 * Authorisation.
 *
 * Roles grant capabilities. A principal carries roles and a tenant list; the
 * gateway checks both before dispatching.
 *
 * The shipped roles are a starting point, not a policy - which is why they are
 * a registry. But two of them encode a control worth keeping: `campaign.author`
 * cannot publish, and `campaign.approver` cannot create. Governance already
 * refuses self-approval at the record level; this refuses it at the door.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { Registry } from "../registry/registry.ts";
import { Registry as RegistryClass } from "../registry/registry.ts";
import type { CapabilityDescriptor } from "../capabilities/descriptors.ts";
import type { Principal, Role } from "./principal.ts";

export const WILDCARD = "*";

export const DEFAULT_ROLES: Role[] = [
  {
    key: "platform.admin",
    label: "Platform administrator",
    description: "Every capability. Should be rare, and is explicit so that it is never accidental.",
    capabilities: [WILDCARD],
  },
  {
    key: "campaign.author",
    label: "Campaign author",
    description: "Authors and tests offers. Deliberately cannot publish its own work.",
    capabilities: [
      "create", "clone", "validate",
      "discover", "search", "compare",
      "apply", "optimize", "simulate", "forecast",
    ],
  },
  {
    key: "campaign.approver",
    label: "Campaign approver",
    description: "Reviews and publishes. Deliberately cannot create, so it cannot approve its own work.",
    capabilities: ["validate", "govern", "publish", "discover", "search", "simulate", "forecast"],
  },
  {
    key: "commerce.surface",
    label: "Commerce surface",
    description: "A storefront or app. Quotes and discovers, but cannot commit value.",
    capabilities: ["discover", "search", "compare", "apply", "optimize", "track"],
  },
  {
    key: "commerce.checkout",
    label: "Checkout service",
    description:
      "The only role that may commit value on a customer's behalf. A caller holding this can grant benefits, so it belongs to a service, never to a person.",
    capabilities: ["apply", "optimize", "reserve", "redeem", "release", "reverse", "track", "attribute"],
  },
  {
    key: "distribution",
    label: "Distribution",
    description: "Issues and activates grants.",
    capabilities: ["issue", "activate", "discover", "search", "track"],
  },
  {
    key: "finance.funding",
    label: "Finance - budgets",
    description:
      "Allocates campaign budgets. Deliberately cannot pay out: funding a budget and paying from it is the classic collapsed duty, and this role was flagged by the platform's own separation check before it shipped.",
    capabilities: ["fund", "forecast", "settle", "audit"],
  },
  {
    key: "finance.treasury",
    label: "Finance - payouts",
    description: "Moves owed balances off the platform. Cannot create the budget it pays from.",
    capabilities: ["pay", "settle", "audit", "forecast"],
  },
  {
    key: "auditor",
    label: "Auditor",
    description: "Read-only. Every capability here is non-mutating.",
    capabilities: ["audit", "settle", "validate", "discover", "search", "compare", "forecast", "simulate"],
  },
  {
    key: "platform.maintenance",
    label: "Maintenance",
    description: "Scheduled internal work. Not reachable from the transport.",
    capabilities: ["audit", "settle"],
  },
];

export function roleRegistry(): Registry<Role> {
  return new RegistryClass<Role>("role").registerAll(DEFAULT_ROLES);
}

export interface AuthorizationRequest {
  readonly principal: Principal;
  readonly capability: string;
  readonly tenant: string;
}

export interface Authorizer {
  authorize(request: AuthorizationRequest): Result<true>;
}

export class RoleAuthorizer implements Authorizer {
  readonly roles: Registry<Role>;

  constructor(roles: Registry<Role> = roleRegistry()) {
    this.roles = roles;
  }

  authorize({ principal, capability, tenant }: AuthorizationRequest): Result<true> {
    // Tenant first: a principal acting for the wrong tenant is a more serious
    // finding than one lacking a capability, and the error should not reveal
    // which capabilities it does hold.
    const tenantAllowed = principal.tenants.includes(WILDCARD) || principal.tenants.includes(tenant);
    if (!tenantAllowed) {
      return fail(ErrorCode.FORBIDDEN, `principal '${principal.id}' may not act for tenant '${tenant}'`, {
        principal: principal.id,
        tenant,
      });
    }

    for (const roleKey of principal.roles) {
      const role = this.roles.get(roleKey);
      if (!role) continue;
      if (role.capabilities.includes(WILDCARD) || role.capabilities.includes(capability)) {
        return ok(true);
      }
    }

    return fail(ErrorCode.FORBIDDEN, `principal '${principal.id}' may not invoke '${capability}'`, {
      principal: principal.id,
      capability,
      roles: principal.roles,
    });
  }

  /** Every capability this principal may invoke. For a console or a token. */
  granted(principal: Principal, capabilities: readonly CapabilityDescriptor[]): string[] {
    const allowed = new Set<string>();
    for (const roleKey of principal.roles) {
      const role = this.roles.get(roleKey);
      if (!role) continue;
      if (role.capabilities.includes(WILDCARD)) {
        for (const capability of capabilities) allowed.add(capability.key);
        break;
      }
      for (const capability of role.capabilities) allowed.add(capability);
    }
    return [...allowed].sort();
  }
}

/* ------------------------------------------------------------------ */

export interface SeparationFinding {
  readonly role: string;
  readonly conflict: readonly string[];
  readonly reason: string;
}

/**
 * Report roles that collapse a separation of duties.
 *
 * Governance already refuses an author approving their own exchange. That check
 * compares identities, so it is defeated by a role that lets one identity do
 * both steps in sequence - which is easy to create by accident when a role is
 * assembled from a list of capabilities somebody needed.
 *
 * This is advisory rather than enforced: some deployments genuinely want an
 * admin role. It exists so the decision is made rather than drifted into.
 */
export function findSeparationOfDutiesIssues(roles: Registry<Role>): SeparationFinding[] {
  const conflicts: [string[], string][] = [
    [["create", "publish"], "can author an offer and publish it without review"],
    [["fund", "pay"], "can fund a budget and pay out from it"],
    [["redeem", "fund"], "can grant benefits and fund the budget that pays for them"],
  ];

  const findings: SeparationFinding[] = [];
  for (const role of roles.list()) {
    if (role.capabilities.includes(WILDCARD)) {
      findings.push({
        role: role.key,
        conflict: [WILDCARD],
        reason: "grants every capability; nothing is separated",
      });
      continue;
    }
    for (const [pair, reason] of conflicts) {
      if (pair.every((capability) => role.capabilities.includes(capability))) {
        findings.push({ role: role.key, conflict: pair, reason });
      }
    }
  }
  return findings;
}
