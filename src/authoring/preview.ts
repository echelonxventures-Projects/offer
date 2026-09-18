/**
 * Rule preview.
 *
 * `validate` checked policy but not *semantics*. A condition comparing a string
 * to money passed review, went live, and then failed at runtime with
 * `RULE_ERROR` — which means the offer silently delivered nothing until
 * somebody noticed revenue was flat. That is the worst production failure mode
 * this platform has, and it is entirely preventable: the condition is a pure
 * function, so it can be run before publishing.
 *
 * Preview evaluates an offer against representative contexts and reports what
 * it finds. It cannot prove an offer is correct — only that it is evaluable,
 * reachable, and not obviously unbounded.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { GoipError } from "../kernel/errors.ts";
import type { Registry } from "../registry/registry.ts";
import type { Amount } from "../universal/economic/amount.ts";
import { compare, toDecimal } from "../universal/economic/amount.ts";
import type { ValueExchange } from "../model/value-exchange.ts";
import type { RuleTraceEntry } from "../rules/ast.ts";
import type { EligibilityCheck } from "../engines/eligibility.ts";
import type { EligibilityEngine } from "../engines/eligibility.ts";
import type { BenefitResolutionEngine } from "../engines/benefit-resolution.ts";
import type { ContextResolutionEngine } from "../context/resolution-engine.ts";
import type { ContextSample } from "./samples.ts";
import type { EconomicAuthority } from "../universal/economic/authority.ts";

export type FindingSeverity = "error" | "warning" | "info";

export interface PreviewFinding {
  /** Stable code, so a console can act on it without parsing prose. */
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  /** The sample that produced it, when it came from one. */
  readonly sample?: string;
}

export interface PreviewOutcome {
  readonly sample: string;
  readonly summary: string;
  readonly applies: boolean;
  /** The first failing check, for an author scanning the report. */
  readonly reason?: string;
  /** What the subject would receive, in the interaction's unit. */
  readonly value?: Amount;
  readonly checks: readonly EligibilityCheck[];
  readonly ruleTrace?: readonly RuleTraceEntry[];
  /** Present when the condition could not be evaluated at all. */
  readonly error?: GoipError;
}

export interface PreviewReport {
  readonly name: string;
  readonly valueExchangeId?: string;
  readonly samplesRun: number;
  readonly appliesTo: number;
  /** False when any finding is an error. Mirrors `PolicyReport.passed`. */
  readonly passed: boolean;
  readonly findings: readonly PreviewFinding[];
  readonly outcomes: readonly PreviewOutcome[];
}

export interface PreviewOptions {
  readonly tenant: string;
  /** Restrict to samples carrying one of these tags. */
  readonly tags?: readonly string[];
  /** Restrict to these sample keys. */
  readonly samples?: readonly string[];
  /** Warn when a single benefit exceeds this, in minor units. */
  readonly largeBenefitMinor?: bigint;
  /** Run samples in this unit. Inferred from the offer when omitted. */
  readonly unit?: string;
}

export interface PreviewDeps {
  readonly context: ContextResolutionEngine;
  readonly eligibility: EligibilityEngine;
  readonly benefits: BenefitResolutionEngine;
  readonly samples: Registry<ContextSample>;
  readonly economic: EconomicAuthority;
}

/**
 * Which unit should the samples run in?
 *
 * The shipped samples are denominated in USD, which produced a spurious error
 * for an offer written in INR: the condition was fine, the sample simply did
 * not match it. So preview infers the offer's unit and re-denominates the
 * samples into it.
 *
 * The minor values are kept as they are rather than converted. Preview is a
 * structural check - "a basket of roughly a hundred units" - and importing an
 * exchange rate would make the report depend on a number that changes daily.
 */
export function inferUnit(exchange: ValueExchange): string | undefined {
  const declared =
    exchange.limits.minimumBase?.unit ??
    exchange.limits.totalBudget?.unit ??
    exchange.limits.maxPerRedemption?.unit ??
    exchange.benefits.find((benefit) => benefit.unit !== undefined)?.unit ??
    exchange.benefits.find((benefit) => benefit.cap?.unit !== undefined)?.cap?.unit;
  if (declared !== undefined) return declared;

  // Nothing declared one, so look for a money literal in the conditions.
  return findAmountUnit(exchange.conditions);
}

function findAmountUnit(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findAmountUnit(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;

  const record = node as Record<string, unknown>;
  const amount = record.amount as { unit?: unknown } | undefined;
  if (amount !== undefined && typeof amount === "object" && typeof amount.unit === "string") {
    return amount.unit;
  }
  for (const value of Object.values(record)) {
    const found = findAmountUnit(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Default threshold for "this benefit is suspiciously large": 1,000 units. */
const DEFAULT_LARGE_BENEFIT = 100_000n;

export class PreviewEngine {
  readonly #deps: PreviewDeps;

  constructor(deps: PreviewDeps) {
    this.#deps = deps;
  }

  /**
   * Run an exchange against the sample contexts.
   *
   * The exchange is evaluated **as if published**: lifecycle and window are
   * neutralised, because previewing a draft should tell you how it will behave
   * once live, not that it is currently a draft.
   */
  async preview(exchange: ValueExchange, options: PreviewOptions): Promise<Result<PreviewReport>> {
    const samples = this.#select(options);
    const asPublished: ValueExchange = { ...exchange, state: "active" };
    const unit = options.unit ?? inferUnit(exchange);

    const outcomes: PreviewOutcome[] = [];
    const findings: PreviewFinding[] = [];

    for (const sample of samples) {
      const outcome = await this.#run(asPublished, sample, options.tenant, unit);
      outcomes.push(outcome);

      if (outcome.error) {
        findings.push({
          code: "rule.unevaluable",
          severity: "error",
          sample: sample.key,
          message:
            `the condition could not be evaluated against '${sample.label}': ${outcome.error.message}. ` +
            `Published, this offer would fail at runtime and deliver nothing.`,
        });
      }
    }

    findings.push(...this.#analyse(asPublished, outcomes, options));

    return ok({
      name: exchange.name,
      ...(exchange.id === "" ? {} : { valueExchangeId: exchange.id }),
      samplesRun: outcomes.length,
      appliesTo: outcomes.filter((outcome) => outcome.applies).length,
      passed: !findings.some((finding) => finding.severity === "error"),
      findings,
      outcomes,
    });
  }

  /** Re-denominate a sample into the offer's unit, keeping the minor values. */
  #denominate(context: ContextSample["context"], unit: string | undefined): ContextSample["context"] {
    if (unit === undefined || context.unit === unit) return context;

    const registered = this.#deps.economic.units.get(unit);
    if (!registered) return context;

    return {
      ...context,
      unit,
      ...(context.cart === undefined
        ? {}
        : {
            cart: {
              lines: context.cart.lines.map((line) => ({
                ...line,
                unitPrice: { unit, minor: line.unitPrice.minor, scale: registered.scale },
              })),
            },
          }),
    };
  }

  #select(options: PreviewOptions): ContextSample[] {
    let samples = this.#deps.samples.list();
    if (options.samples?.length) {
      samples = samples.filter((sample) => options.samples!.includes(sample.key));
    }
    if (options.tags?.length) {
      samples = samples.filter((sample) => sample.tags?.some((tag) => options.tags!.includes(tag)));
    }
    return samples;
  }

  async #run(
    exchange: ValueExchange,
    sample: ContextSample,
    tenant: string,
    unit: string | undefined,
  ): Promise<PreviewOutcome> {
    const base: PreviewOutcome = {
      sample: sample.key,
      summary: sample.summary,
      applies: false,
      checks: [],
    };

    const context = await this.#deps.context.resolve({ ...this.#denominate(sample.context, unit), tenant });
    if (!context.ok) {
      return { ...base, reason: `context could not be resolved: ${context.error.message}`, error: context.error };
    }

    const verdict = await this.#deps.eligibility.evaluate({ exchange, context: context.value });
    if (!verdict.ok) {
      // This is the finding preview exists for.
      return { ...base, reason: verdict.error.message, error: verdict.error };
    }

    if (!verdict.value.eligible) {
      return {
        ...base,
        checks: verdict.value.checks,
        ...(verdict.value.primaryReason === undefined ? {} : { reason: verdict.value.primaryReason }),
        ...(verdict.value.ruleTrace === undefined ? {} : { ruleTrace: verdict.value.ruleTrace }),
      };
    }

    const resolved = await this.#deps.benefits.resolve({ exchange, context: context.value });
    if (!resolved.ok) {
      return { ...base, checks: verdict.value.checks, reason: resolved.error.message, error: resolved.error };
    }

    return {
      ...base,
      applies: true,
      checks: verdict.value.checks,
      value: resolved.value.rankingValue,
      ...(verdict.value.ruleTrace === undefined ? {} : { ruleTrace: verdict.value.ruleTrace }),
    };
  }

  /**
   * Findings that come from the shape of the results rather than from any one
   * sample. These are heuristics, and they say so: an offer that applies
   * nowhere might be correctly targeted at a case the samples do not cover.
   */
  #analyse(
    exchange: ValueExchange,
    outcomes: readonly PreviewOutcome[],
    options: PreviewOptions,
  ): PreviewFinding[] {
    const findings: PreviewFinding[] = [];
    const applying = outcomes.filter((outcome) => outcome.applies);
    const errored = outcomes.some((outcome) => outcome.error);

    if (!errored && applying.length === 0 && outcomes.length > 0) {
      findings.push({
        code: "coverage.none",
        severity: "warning",
        message:
          `applies to none of the ${outcomes.length} sample contexts. Either the targeting is narrower ` +
          `than intended, or the samples do not represent the traffic this is aimed at.`,
      });
    }

    if (applying.length === outcomes.length && outcomes.length > 1) {
      findings.push({
        code: "coverage.universal",
        severity: "info",
        message: `applies to every sample, including the anonymous and minimal ones. Confirm that is intended.`,
      });
    }

    // A benefit that applies but grants nothing is almost always a
    // misconfiguration - a tier nobody meets, a target matching no lines.
    for (const outcome of applying) {
      if (outcome.value && outcome.value.minor === 0n) {
        findings.push({
          code: "benefit.zero",
          severity: "warning",
          sample: outcome.sample,
          message: `qualifies against '${outcome.summary}' but grants nothing. Check the tiers and the benefit target.`,
        });
      }
    }

    const threshold = options.largeBenefitMinor ?? DEFAULT_LARGE_BENEFIT;
    const uncapped = exchange.benefits.filter(
      (benefit) => benefit.cap === undefined && (benefit.type === "percentage" || benefit.type === "tiered"),
    );

    for (const outcome of applying) {
      if (!outcome.value || uncapped.length === 0) continue;
      if (outcome.value.minor > threshold) {
        findings.push({
          code: "benefit.uncapped",
          severity: "warning",
          sample: outcome.sample,
          message:
            `grants ${toDecimal(outcome.value)} ${outcome.value.unit} against '${outcome.summary}', ` +
            `and ${uncapped.length === 1 ? "a benefit has" : `${uncapped.length} benefits have`} no cap. ` +
            `A larger basket grants proportionally more.`,
        });
      }
    }

    // Conditions that only fail on the structural samples are worth naming,
    // because they are usually unintentional.
    const failedAnonymous = outcomes.find((o) => o.sample === "anonymous" && !o.applies && !o.error);
    if (failedAnonymous && applying.length > 0) {
      findings.push({
        code: "requires.subject",
        severity: "info",
        sample: "anonymous",
        message: `does not apply to an anonymous visitor (${failedAnonymous.reason}). Expected for a targeted offer.`,
      });
    }

    const failedEmptyCart = outcomes.find((o) => o.sample === "empty-cart" && !o.applies && !o.error);
    if (failedEmptyCart && applying.length > 0) {
      findings.push({
        code: "requires.cart",
        severity: "info",
        sample: "empty-cart",
        message:
          `does not apply without a basket (${failedEmptyCart.reason}), so it will not appear in discovery ` +
          `before a customer has added anything.`,
      });
    }

    return findings;
  }
}

/** Highest benefit seen across the samples, for a budget sanity check. */
export function largestBenefit(report: PreviewReport): Amount | undefined {
  let largest: Amount | undefined;
  for (const outcome of report.outcomes) {
    if (!outcome.value) continue;
    if (!largest) {
      largest = outcome.value;
      continue;
    }
    const ordering = compare(outcome.value, largest);
    if (ordering.ok && ordering.value > 0) largest = outcome.value;
  }
  return largest;
}
