/**
 * Posting rules.
 *
 * Where the credit side of a benefit lands.
 *
 * This used to be a function with `if (effect.key === "commission")` in it,
 * which meant registering a new effect kind that posted somewhere new required
 * editing the ledger. That is precisely the thing the constitution forbids -
 * Law 2, "anything that varies is a registry entry" - and it survived three
 * phases because nothing was checking.
 *
 * Now an effect kind names a posting rule, and a posting rule is a registry
 * entry. Adding "escrow until delivery confirmed" or "credit a partner's
 * float" is a registration.
 *
 * Account naming is likewise a strategy rather than a template literal: a
 * deployment with an existing chart of accounts should not have to adopt ours.
 */
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode } from "../kernel/errors.ts";
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { Amount } from "../universal/economic/amount.ts";
import type { PartyRef } from "../model/funding.ts";

/**
 * How account identifiers are formed.
 *
 * The default is readable and deterministic, so the same economic event always
 * lands in the same account without a lookup table. A deployment mapping onto
 * an existing general ledger replaces it wholesale.
 */
export interface AccountNaming {
  expense(funderId: string, unit: string): string;
  clearing(tenant: string, unit: string): string;
  subjectWallet(subjectId: string, unit: string): string;
  pointsLiability(subjectId: string, unit: string): string;
  payable(partyKind: string, partyId: string, unit: string): string;
  /** Escape hatch for a rule that needs an account shape none of the above covers. */
  custom(segments: readonly string[]): string;
}

export const defaultAccountNaming: AccountNaming = {
  expense: (funderId, unit) => `exp:${funderId}:${unit}`,
  clearing: (tenant, unit) => `clr:${tenant}:${unit}`,
  subjectWallet: (subjectId, unit) => `liab:wallet:${subjectId}:${unit}`,
  pointsLiability: (subjectId, unit) => `liab:points:${subjectId}:${unit}`,
  payable: (partyKind, partyId, unit) => `pay:${partyKind}:${partyId}:${unit}`,
  custom: (segments) => segments.join(":"),
};

/** What a posting rule is given. Everything it may need, nothing it may not. */
export interface PostingContext {
  readonly tenant: string;
  readonly value: Amount;
  /** The subject, when one is identified. */
  readonly subjectId?: string;
  /** Who a third party benefit is owed to. */
  readonly payee?: PartyRef;
  /** The effect that selected this rule, for error messages. */
  readonly effectKey: string;
  readonly accounts: AccountNaming;
}

export interface PostingTarget {
  readonly accountId: string;
  readonly memo: string;
}

export interface PostingRule extends RegistryEntry {
  /** Does this rule need an identified subject? Checked before it runs. */
  readonly requiresSubject?: boolean;
  /** Does it need a payee, falling back to the subject? */
  readonly requiresPayee?: boolean;
  resolve(context: PostingContext): Result<PostingTarget>;
}

export const DEFAULT_POSTING_RULES: PostingRule[] = [
  {
    key: "clearing",
    label: "Tenant clearing account",
    description:
      "Nets against the merchant settlement run. Where price reductions, fee waivers and granted items land.",
    resolve: ({ tenant, value, accounts }) =>
      ok({ accountId: accounts.clearing(tenant, value.unit), memo: "netted at settlement" }),
  },
  {
    key: "subject_wallet",
    label: "Subject wallet liability",
    description: "The platform now owes the subject money: cashback, wallet credit, stored value.",
    requiresSubject: true,
    resolve: ({ subjectId, value, accounts }) =>
      ok({
        accountId: accounts.subjectWallet(subjectId as string, value.unit),
        memo: `owed to subject ${subjectId}`,
      }),
  },
  {
    key: "subject_points",
    label: "Subject points liability",
    description: "Owed in programme currency rather than money. Kept separate so the two never net against each other.",
    requiresSubject: true,
    resolve: ({ subjectId, value, accounts }) =>
      ok({
        accountId: accounts.pointsLiability(subjectId as string, value.unit),
        memo: `owed to subject ${subjectId}`,
      }),
  },
  {
    key: "third_party_payable",
    label: "Third-party payable",
    description: "Owed to somebody other than the buyer: an affiliate, a creator, a partner.",
    requiresPayee: true,
    resolve: ({ payee, subjectId, value, accounts }) => {
      const target = payee ?? (subjectId ? { kind: "subject", id: subjectId } : undefined);
      if (!target) {
        return fail(ErrorCode.INVALID_REQUEST, "a third-party payable needs a payee");
      }
      return ok({
        accountId: accounts.payable(target.kind, target.id, value.unit),
        memo: `owed to ${target.kind}:${target.id}`,
      });
    },
  },
];

export function postingRuleRegistry(): Registry<PostingRule> {
  return new Registry<PostingRule>("posting-rule").registerAll(DEFAULT_POSTING_RULES);
}

/** Resolve the credit side, enforcing the rule's own prerequisites first. */
export function resolvePosting(
  rule: PostingRule,
  context: PostingContext,
): Result<PostingTarget> {
  if (rule.requiresSubject && context.subjectId === undefined) {
    return fail(
      ErrorCode.INVALID_REQUEST,
      `effect '${context.effectKey}' posts to '${rule.key}', which needs an identified subject`,
      { effect: context.effectKey, posting: rule.key },
    );
  }
  if (rule.requiresPayee && context.payee === undefined && context.subjectId === undefined) {
    return fail(
      ErrorCode.INVALID_REQUEST,
      `effect '${context.effectKey}' posts to '${rule.key}', which needs a payee or an identified subject`,
      { effect: context.effectKey, posting: rule.key },
    );
  }
  return rule.resolve(context);
}
