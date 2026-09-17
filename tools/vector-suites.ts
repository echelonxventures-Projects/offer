/**
 * Conformance vector definitions.
 *
 * Each suite is a pure function of its inputs, which is what makes it
 * expressible as data and therefore portable. Anything that needs a clock, a
 * store or a network is deliberately absent - those are specified as
 * obligations in `spec/storage-contract.md` instead, because a vector cannot
 * express "and it was atomic".
 *
 * Amounts appear in vectors as `{ unit, minor: "<decimal string>", scale }`.
 * `minor` is a string, never a JSON number: a 64-bit value read by a
 * JSON parser that assumes doubles is silently wrong above 2^53, in every
 * language. A string is exact everywhere.
 */
import { canonicalize } from "../src/kernel/canonical.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { decode, encode } from "../src/kernel/codec.ts";
import {
  ROUNDING_MODES,
  add,
  allocate,
  compare,
  divideRound,
  fromDecimal,
  multiplyRate,
  percent,
  subtract,
  toDecimal,
} from "../src/universal/economic/amount.ts";
import type { Amount, RoundingMode } from "../src/universal/economic/amount.ts";
import { SpatialAuthority } from "../src/universal/spatial/authority.ts";
import { TemporalAuthority, fixedClock } from "../src/universal/temporal/authority.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { RuleEvaluator } from "../src/rules/evaluator.ts";
import { ruleOperatorRegistry } from "../src/rules/operators.ts";
import { ruleFunctionRegistry } from "../src/rules/functions.ts";
import { EconomicAuthority } from "../src/universal/economic/authority.ts";
import type { RuleNode } from "../src/rules/ast.ts";
import type { ResolvedContext } from "../src/context/context.ts";
import { findBreach } from "../src/adapters/limit-rules.ts";
import type { LimitMode } from "../src/adapters/limit-rules.ts";
import type { CounterSnapshot } from "../src/adapters/store.ts";
import type { LimitSpec } from "../src/model/limits.ts";
import { DEFAULT_BENEFIT_TYPES } from "../src/model/benefit-types.ts";
import type { BenefitSpec } from "../src/model/benefit.ts";
import type { CartLine } from "../src/context/context.ts";
import { AttributionEngine, attributionModelRegistry } from "../src/attribution/attribution.ts";
import type { Touchpoint } from "../src/attribution/touchpoint.ts";
import { sealRecord, GENESIS_HASH } from "../src/audit/audit-log.ts";
import type { AuditDraft } from "../src/audit/audit-log.ts";
import { unwrap } from "../src/kernel/result.ts";
import { MemoryPlatformStore } from "../src/adapters/memory-store.ts";

export interface VectorCase {
  readonly id: string;
  readonly note?: string;
  readonly input: unknown;
  readonly expect: unknown;
}

export interface VectorSuite {
  readonly suite: string;
  readonly level: "L1" | "L2" | "L3" | "L4";
  readonly description: string;
  readonly cases: VectorCase[];
}

/** Wire form for an amount: minor as a string, always. */
const wire = (a: Amount) => ({ unit: a.unit, minor: a.minor.toString(), scale: a.scale });

/* ------------------------------------------------------------------ *
 * L1 - encoding
 * ------------------------------------------------------------------ */

function canonicalSuite(): VectorSuite {
  const values: [string, unknown][] = [
    ["empty-object", {}],
    ["empty-array", []],
    ["key-order-a", { a: 1, b: 2 }],
    ["key-order-b", { b: 2, a: 1 }],
    ["nested-key-order", { z: { y: 1, x: 2 }, a: [3, { c: 1, b: 2 }] }],
    ["bigint", { v: 10n }],
    ["bigint-negative", { v: -10n }],
    ["bigint-huge", { v: 123456789012345678901234567890n }],
    ["number-vs-bigint", { a: 1, b: 1n }],
    ["null-and-absent", { a: null, b: undefined, c: 1 }],
    ["booleans", { t: true, f: false }],
    ["string-escapes", { s: 'quote " backslash \\ newline \n tab \t' }],
    ["unicode", { s: "héllo wörld ₹ 中文" }],
    ["array-order", [1, 2, 3]],
    ["array-order-reversed", [3, 2, 1]],
    ["deep-nesting", { a: { b: { c: { d: [1, { e: 2n }] } } } }],
    ["amount-shape", { unit: "USD", minor: 1234n, scale: 2 }],
  ];

  return {
    suite: "canonical",
    level: "L1",
    description:
      "Canonical encoding used for hashing. Keys sort; bigints are tagged; absent and " +
      "explicitly-undefined keys encode alike. Two structurally equal values MUST produce " +
      "identical bytes and therefore identical hashes. Non-finite numbers are out of scope: " +
      "JSON cannot carry them, so they cannot reach an implementation over any wire.",
    cases: values.map(([id, value]) => ({
      id,
      input: { value: encode(value) },
      expect: { canonical: canonicalize(value), sha256: sha256(canonicalize(value)) },
    })),
  };
}

function codecSuite(): VectorSuite {
  const texts: [string, string, string?][] = [
    ["plain", '{"a":1,"b":"x"}'],
    ["bigint", '{"v":"~bigint:1234"}'],
    ["bigint-negative", '{"v":"~bigint:-1234"}'],
    ["bigint-huge", '{"v":"~bigint:123456789012345678901234567890"}'],
    ["escaped-literal", '{"v":"~esc:~bigint:9"}', "a plain string that looks like a tag must survive"],
    ["nested", '{"a":[{"b":"~bigint:5"}]}'],
    ["array-of-bigints", '["~bigint:1","~bigint:2"]'],
    ["null", '{"a":null}'],
  ];

  return {
    suite: "codec",
    level: "L1",
    description:
      "Wire codec. `~bigint:N` decodes to an exact integer; a literal string starting with the " +
      "tag is escaped as `~esc:` so the round trip is lossless for every input.",
    cases: texts.map(([id, text, note]) => ({
      id,
      ...(note === undefined ? {} : { note }),
      input: { encoded: text },
      expect: { reEncoded: encode(decode(text)) },
    })),
  };
}

function auditChainSuite(): VectorSuite {
  const drafts: AuditDraft[] = [1, 2, 3].map((n) => ({
    tenant: "t",
    reality: "production",
    kind: "decision.made",
    subject: { kind: "decision", id: `d${n}` },
    actor: "tester",
    at: String(n * 1000),
    payload: { n },
  }));

  const sealed: { seq: number; previousHash: string; hash: string }[] = [];
  let previousHash = GENESIS_HASH;
  for (const [index, draft] of drafts.entries()) {
    const record = sealRecord(draft, index, previousHash);
    sealed.push({ seq: record.seq, previousHash: record.previousHash, hash: record.hash });
    previousHash = record.hash;
  }

  return {
    suite: "audit-chain",
    level: "L1",
    description:
      "Hash chaining. hash = sha256(previousHash + '|' + canonical(record-without-hash)). " +
      "Genesis is 64 zeros. Identical drafts MUST chain to identical hashes in every language.",
    cases: [
      {
        id: "three-record-chain",
        input: { genesis: GENESIS_HASH, drafts: drafts.map((d) => encode(d)) },
        expect: { sealed },
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * L2 - arithmetic
 * ------------------------------------------------------------------ */

function amountSuite(): VectorSuite {
  const cases: VectorCase[] = [];

  for (const [decimal, scale] of [
    ["12.34", 2],
    ["0.001", 3],
    ["100", 0],
    ["-5.50", 2],
    ["0", 2],
    ["92233720368547.75", 2],
    ["1.2300", 2],
  ] as const) {
    const parsed = fromDecimal("X", decimal, scale);
    cases.push({
      id: `parse:${decimal}@${scale}`,
      input: { op: "fromDecimal", unit: "X", decimal, scale },
      expect: { amount: wire(parsed), toDecimal: toDecimal(parsed) },
    });
  }

  cases.push({
    id: "parse:too-much-precision",
    note: "more precision than the unit's scale is an error, never a silent round",
    input: { op: "fromDecimal", unit: "USD", decimal: "1.005", scale: 2 },
    expect: { throws: true },
  });

  for (const [n, d] of [
    [5n, 2n],
    [7n, 2n],
    [-5n, 2n],
    [1n, 3n],
    [-1n, 3n],
    [10n, 5n],
    [-10n, 5n],
    [3n, 2n],
  ] as const) {
    for (const mode of ROUNDING_MODES) {
      cases.push({
        id: `divideRound:${n}/${d}:${mode}`,
        input: { op: "divideRound", numerator: n.toString(), denominator: d.toString(), mode },
        expect: { result: divideRound(n, d, mode as RoundingMode).toString() },
      });
    }
  }

  for (const [decimal, rate] of [
    ["12.34", "12.5"],
    ["0.30", "10"],
    ["100.00", "33.333"],
    ["1097.00", "15"],
    ["40000.00", "5"],
    ["0.01", "50"],
  ] as const) {
    const base = fromDecimal("USD", decimal, 2);
    for (const mode of ROUNDING_MODES) {
      cases.push({
        id: `percent:${rate}%of${decimal}:${mode}`,
        input: { op: "multiplyRate", amount: wire(base), percent: rate, mode },
        expect: { amount: wire(multiplyRate(base, percent(rate), mode as RoundingMode)) },
      });
    }
  }

  const a = fromDecimal("USD", "1.11", 2);
  const b = fromDecimal("USD", "2.22", 2);
  cases.push(
    {
      id: "add",
      input: { op: "add", left: wire(a), right: wire(b) },
      expect: { amount: wire(unwrap(add(a, b))) },
    },
    {
      id: "subtract-into-negative",
      input: { op: "subtract", left: wire(a), right: wire(fromDecimal("USD", "3.00", 2)) },
      expect: { amount: wire(unwrap(subtract(a, fromDecimal("USD", "3.00", 2)))) },
    },
    {
      id: "add-unit-mismatch",
      note: "mixing units is an error, not a coercion",
      input: { op: "add", left: wire(a), right: wire(fromDecimal("EUR", "1.00", 2)) },
      expect: { error: "UNIT_MISMATCH" },
    },
    {
      id: "add-scale-mismatch",
      input: { op: "add", left: wire(a), right: { unit: "USD", minor: "100", scale: 3 } },
      expect: { error: "UNIT_MISMATCH" },
    },
    {
      id: "compare-across-sign",
      input: { op: "compare", left: wire(fromDecimal("USD", "-1.00", 2)), right: wire(a) },
      expect: { ordering: unwrap(compare(fromDecimal("USD", "-1.00", 2), a)) },
    },
  );

  return {
    suite: "amount",
    level: "L2",
    description:
      "Exact integer money. Every rounding mode over positive and negative operands, " +
      "percentages as exact rationals, and the refusals that keep units from mixing.",
    cases,
  };
}

function allocateSuite(): VectorSuite {
  const inputs: [string, string, number, bigint[]][] = [
    ["0.01 three ways", "0.01", 2, [1n, 1n, 1n]],
    ["0.10 three ways", "0.10", 2, [1n, 1n, 1n]],
    ["100.00 evenly", "100.00", 2, [1n, 1n, 1n]],
    ["100.00 by 2:1", "100.00", 2, [2n, 1n]],
    ["12.34 by 7:2:1", "12.34", 2, [7n, 2n, 1n]],
    ["0.07 six ways", "0.07", 2, [1n, 1n, 1n, 1n, 1n, 1n]],
    ["999.99 single", "999.99", 2, [1n]],
    ["negative", "-0.10", 2, [1n, 1n, 1n]],
    ["zero", "0.00", 2, [1n, 1n]],
    ["weights 5:3:2", "1.00", 2, [5n, 3n, 2n]],
    ["one zero weight", "1.00", 2, [1n, 0n, 1n]],
    ["points scale 0", "7", 0, [1n, 1n, 1n]],
  ];

  const cases: VectorCase[] = inputs.map(([id, decimal, scale, weights]) => {
    const amount = fromDecimal("USD", decimal, scale);
    const parts = unwrap(allocate(amount, weights));
    return {
      id,
      input: { amount: wire(amount), weights: weights.map((w) => w.toString()) },
      expect: {
        parts: parts.map(wire),
        sum: parts.reduce((t, p) => t + p.minor, 0n).toString(),
      },
    };
  });

  cases.push(
    { id: "reject:no-weights", input: { amount: wire(fromDecimal("USD", "1.00", 2)), weights: [] }, expect: { error: "INVALID_REQUEST" } },
    { id: "reject:all-zero", input: { amount: wire(fromDecimal("USD", "1.00", 2)), weights: ["0", "0"] }, expect: { error: "INVALID_REQUEST" } },
    { id: "reject:negative-weight", input: { amount: wire(fromDecimal("USD", "1.00", 2)), weights: ["-1", "2"] }, expect: { error: "INVALID_REQUEST" } },
  );

  return {
    suite: "allocate",
    level: "L2",
    description:
      "Remainder-preserving division. Parts MUST sum exactly to the whole, and the remainder " +
      "MUST go to the largest weight first, ties broken by index. This ordering is normative: " +
      "it is what makes multi-party funding and attribution reconcilable.",
    cases,
  };
}

export const SUITES_L1_L2 = [canonicalSuite, codecSuite, auditChainSuite, amountSuite, allocateSuite];

/* exported for the second half of the generator */
export { wire, unwrap };
export {
  SpatialAuthority,
  TemporalAuthority,
  fixedClock,
  instant,
  RuleEvaluator,
  ruleOperatorRegistry,
  ruleFunctionRegistry,
  EconomicAuthority,
  findBreach,
  DEFAULT_BENEFIT_TYPES,
  AttributionEngine,
  attributionModelRegistry,
  MemoryPlatformStore,
  fromDecimal,
  toDecimal,
  encode,
};
export type {
  RuleNode,
  ResolvedContext,
  LimitMode,
  CounterSnapshot,
  LimitSpec,
  BenefitSpec,
  CartLine,
  Touchpoint,
  Amount,
};
