/**
 * Generates the conformance vectors from the reference implementation, then
 * freezes them.
 *
 * Generating from the reference is the only honest option - the reference is
 * what defines the behaviour. What makes the vectors a specification rather
 * than a snapshot is that they are *committed*, so an unintended change in
 * behaviour appears as a diff in a reviewed file rather than as a silently
 * updated expectation.
 *
 *   npm run vectors:generate   rewrite them
 *   npm run vectors:check      fail if they have drifted (runs in `verify`)
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SUITES_L1_L2 } from "./vector-suites.ts";
import { buildLevel3And4 } from "./vector-suites-2.ts";
import type { VectorSuite } from "./vector-suites.ts";

const OUT = new URL("../spec/vectors", import.meta.url).pathname;

/** Stable, readable JSON. Bigints must already be strings by this point. */
function render(suite: VectorSuite): string {
  return `${JSON.stringify(suite, replacer, 2)}\n`;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    throw new Error("a raw bigint reached the vector file; convert it to a string first");
  }
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

const suites: VectorSuite[] = [...SUITES_L1_L2.map((build) => build()), ...(await buildLevel3And4())];

mkdirSync(OUT, { recursive: true });

const check = process.argv.includes("--check");
let drifted = 0;
let cases = 0;

for (const suite of suites) {
  const path = join(OUT, `${suite.suite}.json`);
  const content = render(suite);
  cases += suite.cases.length;

  if (check) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current !== content) {
      console.error(`  DRIFT  spec/vectors/${suite.suite}.json`);
      drifted += 1;
    }
  } else {
    writeFileSync(path, content);
    console.log(`  ${suite.level}  ${suite.suite.padEnd(14)} ${String(suite.cases.length).padStart(4)} cases`);
  }
}

if (check) {
  if (drifted > 0) {
    console.error(`\n${drifted} vector file(s) no longer match the reference implementation.`);
    console.error("If the change was intended, run: npm run vectors:generate");
    process.exit(1);
  }
  console.log(`conformance vectors are current: ${suites.length} suites, ${cases} cases.`);
} else {
  console.log(`\nwrote ${suites.length} suites, ${cases} cases to spec/vectors/`);
}
