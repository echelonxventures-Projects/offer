/**
 * Rule evaluator.
 *
 * Total by construction: bounded depth, bounded node budget, no loops that are
 * not bounded by the rule's own literal arrays, no I/O. A rule either returns a
 * boolean with a trace, or a typed error naming the node that failed.
 *
 * The trace is not a debugging nicety. "Why did I not get the discount?" is the
 * single most common question this platform will ever be asked, and the trace
 * is the answer.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { Json } from "../kernel/types.ts";
import type { ResolvedContext } from "../context/context.ts";
import { readPath } from "../context/context.ts";
import { fromDecimal } from "../universal/economic/amount.ts";
import type { RuleNode, RuleTraceEntry, Term } from "./ast.ts";
import { isTerm } from "./ast.ts";
import type { EvalContext, RuleDeps } from "./types.ts";

export interface EvaluationLimits {
  /** Maximum nesting depth of logical operators. */
  readonly maxDepth: number;
  /** Maximum number of nodes and terms evaluated in one rule. */
  readonly maxNodes: number;
}

export const DEFAULT_LIMITS: EvaluationLimits = { maxDepth: 32, maxNodes: 5_000 };

export interface EvaluationOutcome {
  readonly satisfied: boolean;
  readonly trace: readonly RuleTraceEntry[];
  /** Nodes and terms actually evaluated; useful for cost accounting. */
  readonly nodesEvaluated: number;
}

export class RuleEvaluator {
  readonly #deps: RuleDeps;
  readonly #limits: EvaluationLimits;

  constructor(deps: RuleDeps, limits: EvaluationLimits = DEFAULT_LIMITS) {
    this.#deps = deps;
    this.#limits = limits;
  }

  evaluate(node: RuleNode | undefined, context: ResolvedContext): Result<EvaluationOutcome> {
    // An absent condition means "no condition", which is satisfied. This is the
    // right default: an offer with no eligibility rules is open to everyone.
    if (node === undefined) {
      return ok({ satisfied: true, trace: [], nodesEvaluated: 0 });
    }

    const trace: RuleTraceEntry[] = [];
    let budget = this.#limits.maxNodes;
    const limits = this.#limits;
    const deps = this.#deps;

    const makeCtx = (depth: number): EvalContext => ({
      context,
      deps,
      trace,
      depth,
      evaluate: (child) => evaluateNode(child, depth + 1),
      resolve: (term) => resolveTerm(term, depth),
      spend: () => {
        budget -= 1;
        return budget < 0
          ? fail(ErrorCode.RULE_ERROR, `rule exceeded the node budget of ${limits.maxNodes}`)
          : ok(true);
      },
    });

    function resolveTerm(term: unknown, depth: number): Result<unknown> {
      const ctx = makeCtx(depth);
      const spent = ctx.spend();
      if (!spent.ok) return spent;

      if (!isTerm(term)) {
        // Bare JSON in an argument position is treated as a literal, which
        // makes hand-written rules and console-generated rules interoperable.
        return ok(term);
      }

      if ("literal" in term) return ok(term.literal);

      if ("path" in term) {
        const value = readPath(context, term.path);
        if (value === undefined && term.default !== undefined) return ok(term.default);
        return ok(value);
      }

      if ("amount" in term) {
        const unit = deps.economic.units.require(term.amount.unit);
        if (!unit.ok) return unit;
        return ok(fromDecimal(term.amount.unit, term.amount.decimal, unit.value.scale));
      }

      const found = deps.functions.require(term.fn);
      if (!found.ok) return found;
      const rawArgs: readonly Term[] = term.args ?? [];
      if (found.value.arity >= 0 && rawArgs.length !== found.value.arity) {
        return fail(ErrorCode.RULE_ERROR, `function '${term.fn}' expects ${found.value.arity} argument(s), got ${rawArgs.length}`);
      }
      const values: unknown[] = [];
      for (const arg of rawArgs) {
        const resolved = resolveTerm(arg, depth + 1);
        if (!resolved.ok) return resolved;
        values.push(resolved.value);
      }
      return found.value.call(values, ctx, rawArgs);
    }

    function evaluateNode(raw: unknown, depth: number): Result<boolean> {
      if (depth > limits.maxDepth) {
        return fail(ErrorCode.RULE_ERROR, `rule nested deeper than ${limits.maxDepth}`);
      }
      if (typeof raw !== "object" || raw === null || typeof (raw as RuleNode).op !== "string") {
        return fail(ErrorCode.RULE_ERROR, "rule node must be an object with an 'op' property", {
          node: raw as Json,
        });
      }

      const ctx = makeCtx(depth);
      const spent = ctx.spend();
      if (!spent.ok) return spent;

      const node = raw as RuleNode;
      const operator = deps.operators.require(node.op);
      if (!operator.ok) return operator;

      const outcome = operator.value.evaluate(node, ctx);
      if (!outcome.ok) {
        return fail(outcome.error.code, `operator '${node.op}': ${outcome.error.message}`, {
          op: node.op,
          ...outcome.error.details,
        });
      }

      trace.push({
        op: node.op,
        result: outcome.value.result,
        depth,
        ...(outcome.value.detail === undefined ? {} : { detail: outcome.value.detail }),
      });
      return ok(outcome.value.result);
    }

    const result = evaluateNode(node, 0);
    if (!result.ok) return result;
    return ok({
      satisfied: result.value,
      trace,
      nodesEvaluated: this.#limits.maxNodes - budget,
    });
  }
}
