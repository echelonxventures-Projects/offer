/**
 * Decision replay.
 *
 * "Prove this customer was told the right price, eight months ago."
 *
 * A decision is a pure function of three things: the context, the registries,
 * and the instant. All three are now pinned — the context trace is recorded,
 * the bundle version is recorded, and the clock is injected — so a decision can
 * be re-run and checked against the hash in the audit chain.
 *
 * **The platform does not store contexts.** They contain customer data and they
 * are the largest thing per decision by an order of magnitude, so retaining
 * every one to make replay convenient would be the wrong trade in both
 * directions. The caller supplies the context from its own records; what the
 * platform guarantees is that the same context under the same bundle reproduces
 * the same decision, byte for byte.
 */
import type { Result } from "../kernel/result.ts";
import { ok } from "../kernel/result.ts";
import type { ContextRequest } from "../context/context.ts";
import type { Decision } from "../engines/decision.ts";
import type { GoipPlatform } from "../platform/platform.ts";
import type { BundleDifference } from "../platform/bundle.ts";
import { compareRegistryKeys } from "../platform/bundle.ts";

export interface ReplayRequest {
  /** The decision to reproduce, as recorded. */
  readonly decision: Decision;
  /** The context that produced it, from the caller's own records. */
  readonly context: ContextRequest;
  /** Candidates to consider. Defaults to those the decision recorded. */
  readonly candidateIds?: readonly string[];
  readonly codes?: readonly string[];
  /**
   * The registry keys recorded alongside the original bundle id, if the
   * deployment kept a manifest. Supplying them turns "the rules changed" from
   * an assertion into a list.
   */
  readonly recordedRegistryKeys?: Readonly<Record<string, readonly string[]>>;
}

export interface ReplayResult {
  /** The decision hashed identically. This is the claim that matters. */
  readonly reproduced: boolean;
  readonly originalHash: string;
  readonly replayedHash: string;

  /** Was the platform running the same registry bundle? */
  readonly bundleMatches: boolean;
  readonly originalBundle: string;
  readonly currentBundle: string;
  /**
   * Which registries differ, when the bundle has moved on AND the caller
   * supplied the recorded registry keys to compare against.
   *
   * Absent otherwise — including when the bundle plainly differs. A bundle id
   * is a hash, and a hash cannot be un-hashed into the keys that produced it.
   * Reporting an empty array here would say "the bundles differ and nothing
   * differs", which is not a limitation, it is a contradiction. Absent means
   * "not known from what was recorded", which is the truth.
   *
   * To populate it, pass `recordedRegistryKeys` from a stored bundle manifest.
   */
  readonly bundleDifferences?: readonly BundleDifference[];

  /** What an investigator should conclude, in one sentence. */
  readonly conclusion: string;
  readonly replayed: Decision;
}

export async function replayDecision(
  platform: GoipPlatform,
  request: ReplayRequest,
): Promise<Result<ReplayResult>> {
  const { decision } = request;
  const currentBundle = platform.bundleVersion();
  const bundleMatches = decision.bundle === currentBundle.id;

  // Pin the clock to the recorded instant. Without this, any window or
  // calendar condition is evaluated against today and the replay is worthless.
  const context: ContextRequest = {
    ...request.context,
    tenant: decision.tenant,
    reality: decision.reality,
    ...(request.context.instant === undefined
      ? { instant: { chronology: "earth.unix.ms", tick: BigInt(decision.at) } }
      : {}),
    ...(decision.correlationId === "" ? {} : { correlationId: decision.correlationId }),
  };

  const resolved = await platform.context.resolve(context);
  if (!resolved.ok) return resolved;

  const replayed = await platform.decisions.decide({
    context: resolved.value,
    objective: decision.objective,
    ...(request.candidateIds === undefined
      ? { candidateIds: decision.applied.map((applied) => applied.valueExchangeId) }
      : { candidateIds: request.candidateIds }),
    ...(request.codes === undefined ? {} : { presentedCodes: request.codes }),
  });
  if (!replayed.ok) return replayed;

  const reproduced = replayed.value.hash === decision.hash;

  return ok({
    reproduced,
    originalHash: decision.hash,
    replayedHash: replayed.value.hash,
    bundleMatches,
    originalBundle: decision.bundle,
    currentBundle: currentBundle.id,
    ...(bundleMatches || request.recordedRegistryKeys === undefined
      ? {}
      : { bundleDifferences: compareRegistryKeys(request.recordedRegistryKeys, platform.registries) }),
    conclusion: conclude(reproduced, bundleMatches),
    replayed: replayed.value,
  });
}

/**
 * The four outcomes, and what each one actually licenses you to say.
 *
 * The third is the important one: a decision that fails to reproduce under a
 * *changed* bundle is not evidence of a fault. Saying so plainly stops an
 * investigation drawing the wrong conclusion from a true observation.
 */
function conclude(reproduced: boolean, bundleMatches: boolean): string {
  if (reproduced && bundleMatches) {
    return "Reproduced exactly, under the same registry bundle. The recorded decision is what the platform would produce today from this context.";
  }
  if (reproduced && !bundleMatches) {
    return "Reproduced exactly, although the registry bundle has changed since. Nothing the decision depended on was affected.";
  }
  if (!reproduced && !bundleMatches) {
    return "Did not reproduce, and the registry bundle has changed since. This is expected rather than evidence of a fault: compare the bundles before concluding anything.";
  }
  return "Did not reproduce under the same registry bundle. Either the supplied context differs from the original, or something non-deterministic has entered the decision path. Investigate.";
}
