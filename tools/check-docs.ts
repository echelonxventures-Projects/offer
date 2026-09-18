/**
 * Documentation integrity checks.
 *
 * Two things that are easy to claim and easy to let rot:
 *
 *   1. Every internal link resolves.
 *   2. Every alert rule's runbook link points at a section that exists.
 *
 * The second matters more than it looks. Alert rules require a `runbook` field,
 * which is the mechanism for "no alert without a defined response" - but a
 * required field pointing at a deleted heading is worse than no field, because
 * it looks answered. This makes the claim enforceable.
 *
 *   npm run docs:check
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { DEFAULT_ALERT_RULES } from "../src/observability/alerts.ts";

const ROOT = new URL("..", import.meta.url).pathname;

function markdownFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (entry === "node_modules" || entry.startsWith(".")) return [];
    if (statSync(full).isDirectory()) return markdownFiles(full);
    return full.endsWith(".md") ? [full] : [];
  });
}

/**
 * GitHub's heading anchor rules: lowercase, drop punctuation but keep word
 * characters and hyphens, collapse whitespace to hyphens.
 */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function headingAnchors(file: string): Set<string> {
  const content = readFileSync(file, "utf8");
  return new Set([...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1] as string)));
}

const problems: string[] = [];
const files = markdownFiles(ROOT);
let links = 0;

/* 1. Internal links resolve, including their anchors. */
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1] as string;
    if (target.startsWith("http") || target.startsWith("mailto:")) continue;
    links += 1;

    const [path, anchor] = target.split("#");
    const resolved = path ? resolve(dirname(file), path) : file;

    if (!existsSync(resolved)) {
      problems.push(`${relative(ROOT, file)}: broken link -> ${target}`);
      continue;
    }
    if (anchor && resolved.endsWith(".md") && !headingAnchors(resolved).has(anchor)) {
      problems.push(`${relative(ROOT, file)}: anchor not found -> ${target}`);
    }
  }
}

/* 2. Every alert rule points at a runbook section that exists. */
for (const rule of DEFAULT_ALERT_RULES) {
  const [path, anchor] = rule.runbook.split("#");
  const resolved = resolve(ROOT, path as string);

  if (!existsSync(resolved)) {
    problems.push(`alert '${rule.key}': runbook file does not exist -> ${rule.runbook}`);
    continue;
  }
  if (!anchor) {
    problems.push(`alert '${rule.key}': runbook link has no section anchor`);
    continue;
  }
  if (!headingAnchors(resolved).has(anchor)) {
    problems.push(`alert '${rule.key}': runbook section does not exist -> #${anchor}`);
  }
}

console.log(`checked ${links} internal links across ${files.length} files`);
console.log(`checked ${DEFAULT_ALERT_RULES.length} alert rules for a resolvable runbook section`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("documentation is consistent.");
