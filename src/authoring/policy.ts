/**
 * The governance policy that closes the RULE_ERROR gap.
 *
 * Until now `validate` checked policy but not semantics, so a condition that
 * could not be evaluated passed review and failed at runtime — where the
 * failure is silent, because an offer that errors simply never applies.
 *
 * This runs preview during the publish gate. An unevaluable condition now
 * blocks publication instead of reaching production.
 *
 * It is a policy rather than a special case inside `publish` so it composes
 * with the rest of the gate: it can be removed by a deployment that has its own
 * validation, and it shows up in the policy report alongside everything else.
 */
import { ok } from "../kernel/result.ts";
import type { Policy, PolicyViolation } from "../engines/governance.ts";
import type { PreviewEngine } from "./preview.ts";

export interface EvaluablePolicyOptions {
  readonly preview: PreviewEngine;
  /** Samples to check against. Defaults to those tagged "core". */
  readonly tags?: readonly string[];
  /**
   * Also surface preview warnings as policy warnings.
   *
   * Off by default: preview warnings are heuristics, and a governance gate that
   * cries wolf gets bypassed. Errors always block.
   */
  readonly includeWarnings?: boolean;
}

export function evaluableConditionsPolicy(options: EvaluablePolicyOptions): Policy {
  return {
    key: "rules.evaluable",
    label: "Conditions must be evaluable",
    description:
      "Runs the offer against sample contexts before it can go live. A condition that cannot be evaluated " +
      "does not fail loudly in production - the offer simply never applies, and nobody notices until " +
      "somebody asks why revenue is flat.",
    severity: "error",
    async check({ exchange }) {
      const report = await options.preview.preview(exchange, {
        tenant: exchange.tenant,
        tags: options.tags ?? ["core"],
      });
      if (!report.ok) {
        return ok([
          {
            policy: "rules.evaluable",
            severity: "error",
            message: `preview could not run: ${report.error.message}`,
            path: "conditions",
          },
        ]);
      }

      const violations: PolicyViolation[] = [];
      for (const finding of report.value.findings) {
        if (finding.severity === "error") {
          violations.push({
            policy: "rules.evaluable",
            severity: "error",
            message: finding.message,
            path: "conditions",
          });
        } else if (options.includeWarnings && finding.severity === "warning") {
          violations.push({
            policy: "rules.evaluable",
            severity: "warning",
            message: finding.message,
            path: finding.code.startsWith("benefit") ? "benefits" : "conditions",
          });
        }
      }
      return ok(violations);
    },
  };
}
