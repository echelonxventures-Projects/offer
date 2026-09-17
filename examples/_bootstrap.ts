/**
 * Shared setup for the examples.
 *
 * A fixed clock and a sequential id factory make every example's output
 * reproducible byte for byte, which is also how the tests assert on them.
 */
import { GoipPlatform } from "../src/platform/platform.ts";
import { sequentialIdFactory } from "../src/kernel/ids.ts";
import { fixedClock } from "../src/universal/temporal/authority.ts";
import { toDecimal } from "../src/universal/economic/amount.ts";
import type { Amount } from "../src/universal/economic/amount.ts";
import type { Result } from "../src/kernel/result.ts";

/** Saturday 19 September 2026, 10:30 UTC. Chosen so weekend rules fire. */
export const DEMO_INSTANT_MS = Date.UTC(2026, 8, 19, 10, 30, 0);

export const TENANT = "demo";

export function demoPlatform(): GoipPlatform {
  return new GoipPlatform({
    clock: fixedClock(BigInt(DEMO_INSTANT_MS) * 1_000_000n),
    ids: sequentialIdFactory(),
  });
}

/** Unwrap or print the error and exit; examples should fail loudly. */
export function must<T>(result: Result<T>, what: string): T {
  if (!result.ok) {
    console.error(`\n  FAILED: ${what}`);
    console.error(`  ${result.error.code}: ${result.error.message}`);
    if (result.error.details) console.error("  details:", JSON.stringify(result.error.details, replacer, 2));
    process.exit(1);
  }
  return result.value;
}

const replacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

export const money = (a: Amount): string => `${toDecimal(a)} ${a.unit}`;

export function heading(title: string): void {
  console.log(`\n${"=".repeat(74)}\n${title}\n${"=".repeat(74)}`);
}

export function section(title: string): void {
  console.log(`\n-- ${title} ${"-".repeat(Math.max(0, 68 - title.length))}`);
}

export function row(label: string, value: string): void {
  console.log(`   ${label.padEnd(30)} ${value}`);
}
