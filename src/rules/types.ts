/**
 * Shared types for the rule engine. Separated from the evaluator so operators
 * and functions can be written without importing the evaluator itself.
 */
import type { Result } from "../kernel/result.ts";
import type { RegistryEntry, Registry } from "../registry/registry.ts";
import type { ResolvedContext } from "../context/context.ts";
import type { TemporalAuthority } from "../universal/temporal/authority.ts";
import type { SpatialAuthority } from "../universal/spatial/authority.ts";
import type { EconomicAuthority } from "../universal/economic/authority.ts";
import type { RuleNode, RuleTraceEntry, Term } from "./ast.ts";

export interface RuleDeps {
  readonly temporal: TemporalAuthority;
  readonly spatial: SpatialAuthority;
  readonly economic: EconomicAuthority;
  readonly operators: Registry<RuleOperator>;
  readonly functions: Registry<RuleFunction>;
}

/** What an operator or function is given when it runs. */
export interface EvalContext {
  readonly context: ResolvedContext;
  readonly deps: RuleDeps;
  readonly trace: RuleTraceEntry[];
  readonly depth: number;
  /** Evaluate a child node one level deeper. */
  evaluate(node: unknown): Result<boolean>;
  /** Resolve a term to a concrete value. */
  resolve(term: unknown): Result<unknown>;
  /** Consume one unit of the evaluation budget. */
  spend(): Result<true>;
}

export interface OperatorOutcome {
  readonly result: boolean;
  /** Human-readable explanation recorded in the decision trace. */
  readonly detail?: string;
}

export interface RuleOperator extends RegistryEntry {
  /** Documentation: the argument names this operator reads off the node. */
  readonly args: readonly string[];
  /** True for operators that combine other nodes (all/any/not). */
  readonly logical?: boolean;
  evaluate(node: RuleNode, ctx: EvalContext): Result<OperatorOutcome>;
}

export interface RuleFunction extends RegistryEntry {
  /** Documentation: expected argument count, -1 for variadic. */
  readonly arity: number;
  call(args: readonly unknown[], ctx: EvalContext, rawArgs: readonly Term[]): Result<unknown>;
}
