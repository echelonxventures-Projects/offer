/**
 * Registry bundle versions.
 *
 * A decision is a pure function of its context *and the registries that were
 * loaded when it was made*. The context was already recorded; the registries
 * were not, which left a real hole in dispute resolution: re-running a decision
 * from eight months ago could produce a different answer because a benefit type
 * was added or a policy changed, and nothing would say so.
 *
 * A bundle version is a deterministic hash of the extension surface — every
 * registry, every key. Decisions carry it, so a replay can state plainly
 * whether it ran under the same rules.
 *
 * What it hashes and what it cannot:
 *
 *   - **Keys are hashed.** Adding, removing or renaming an entry changes the
 *     version, which is the case that matters.
 *   - **Behaviour is not.** A registry entry holds functions, and a function
 *     has no stable serialisation. Editing a benefit handler's arithmetic
 *     without touching its key produces the *same* version. That is a real
 *     limit, and it is why the version is evidence rather than proof: it pairs
 *     with the deployment's own build identifier, which is what changes when
 *     code changes.
 */
import { hashValue } from "../kernel/hash.ts";
import type { Registry } from "../registry/registry.ts";

export interface BundleVersion {
  /** Short, stable identifier. The first 16 hex characters of the full hash. */
  readonly id: string;
  /** Full SHA-256 over the canonical form of every registry's keys. */
  readonly hash: string;
  /** Per registry, how many entries it held. For a human reading a diff. */
  readonly registries: Readonly<Record<string, number>>;
  /** Total entries across every registry. */
  readonly entries: number;
}

type AnyRegistry = Registry<{ key: string; label: string }>;

/** Deterministic: the same registries always produce the same version. */
export function computeBundleVersion(registries: Readonly<Record<string, AnyRegistry>>): BundleVersion {
  const names = Object.keys(registries).sort();

  const shape: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  let entries = 0;

  for (const name of names) {
    const registry = registries[name] as AnyRegistry;
    const keys = registry.keys(); // already sorted
    shape[name] = keys;
    counts[name] = keys.length;
    entries += keys.length;
  }

  const hash = hashValue(shape);
  return { id: hash.slice(0, 16), hash, registries: counts, entries };
}

/** Sum of every registry's mutation counter. Cheap staleness detection. */
export function revisionOf(registries: Readonly<Record<string, AnyRegistry>>): number {
  let total = 0;
  for (const registry of Object.values(registries)) total += registry.revision;
  return total;
}

/**
 * What changed between two bundles.
 *
 * Reported per registry rather than as one number, because "the bundle
 * changed" is not actionable and "the policy registry gained an entry" is.
 */
export interface BundleDifference {
  readonly registry: string;
  readonly before: number;
  readonly after: number;
  /** Keys present now and not before. Only when comparing recorded keys. */
  readonly added?: readonly string[];
  /** Keys present before and not now. Only when comparing recorded keys. */
  readonly removed?: readonly string[];
}

export function compareBundles(before: BundleVersion, after: BundleVersion): BundleDifference[] {
  const names = new Set([...Object.keys(before.registries), ...Object.keys(after.registries)]);
  const differences: BundleDifference[] = [];

  for (const registry of [...names].sort()) {
    const was = before.registries[registry] ?? 0;
    const now = after.registries[registry] ?? 0;
    if (was !== now) differences.push({ registry, before: was, after: now });
  }
  return differences;
}

/**
 * Compare a recorded set of registry keys against the live registries.
 *
 * `compareBundles` works on counts, which is all a `BundleVersion` carries, so
 * it can say a registry gained an entry but not which one. A deployment that
 * kept a manifest of the actual keys gets the better answer here: the names.
 *
 * A registry whose count is unchanged but whose keys differ — one entry
 * replaced by another — is reported, because `before === after` on the count
 * would otherwise hide exactly the change most likely to alter a decision.
 */
export function compareRegistryKeys(
  recorded: Readonly<Record<string, readonly string[]>>,
  current: Readonly<Record<string, AnyRegistry>>,
): BundleDifference[] {
  const names = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  const differences: BundleDifference[] = [];

  for (const registry of [...names].sort()) {
    const was = new Set(recorded[registry] ?? []);
    const registryNow = current[registry];
    const now = new Set(registryNow === undefined ? [] : registryNow.keys());

    const added = [...now].filter((key) => !was.has(key)).sort();
    const removed = [...was].filter((key) => !now.has(key)).sort();
    if (added.length === 0 && removed.length === 0) continue;

    differences.push({
      registry,
      before: was.size,
      after: now.size,
      ...(added.length === 0 ? {} : { added }),
      ...(removed.length === 0 ? {} : { removed }),
    });
  }
  return differences;
}
