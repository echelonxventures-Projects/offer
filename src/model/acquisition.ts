/**
 * Acquisition modes.
 *
 * How a subject comes to hold a value exchange. This was a `switch` in the
 * eligibility engine over a closed union of five strings, which meant the
 * answer to "how might somebody obtain an offer" was fixed by the platform
 * rather than by the business.
 *
 * It is a registry now. "Holds a qualifying NFT", "was invited by a clinician",
 * "passed a KYC tier", "presented a partner token" are all registrations.
 *
 * Modes are pure functions of the exchange, the context and the grants already
 * loaded. Anything needing an external lookup resolves it into a context facet
 * first, for the same reason rule operators do.
 */
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry } from "../registry/registry.ts";
import type { ResolvedContext } from "../context/context.ts";
import type { Grant, ValueExchange } from "./value-exchange.ts";

export interface AcquisitionInput {
  readonly exchange: ValueExchange;
  readonly context: ResolvedContext;
  /** Codes presented with this request. */
  readonly presentedCodes: readonly string[];
  /** Grants this subject holds for this exchange, in a usable state. */
  readonly grants: readonly Grant[];
}

export interface AcquisitionVerdict {
  readonly passed: boolean;
  /** Shown in the eligibility trace, so it must read as an explanation. */
  readonly detail: string;
}

export interface AcquisitionMode extends RegistryEntry {
  /** True when the subject must be identified for this mode to be satisfiable. */
  readonly requiresIdentifiedSubject?: boolean;
  check(input: AcquisitionInput): AcquisitionVerdict;
}

/** Codes are compared case- and whitespace-insensitively, everywhere. */
export const normaliseCode = (code: string): string => code.trim().toUpperCase();

/** Shared by every mode that works from a held grant. */
function fromGrant(input: AcquisitionInput, modeLabel: string): AcquisitionVerdict {
  if (input.context.subject.anonymous) {
    return { passed: false, detail: `'${modeLabel}' requires an identified subject` };
  }
  const usable = input.grants.find((grant) => grant.uses < grant.maxUses);
  if (!usable) return { passed: false, detail: "subject holds no usable grant" };
  if (input.exchange.acquisition.requiresActivation && usable.state !== "activated") {
    return { passed: false, detail: "grant has not been activated" };
  }
  return { passed: true, detail: `grant ${usable.id} (${usable.uses}/${usable.maxUses} used)` };
}

export const DEFAULT_ACQUISITION_MODES: AcquisitionMode[] = [
  {
    key: "automatic",
    label: "Applies automatically",
    description: "No action by the subject. Promotions, cashback, commissions.",
    check: () => ({ passed: true, detail: "applies automatically" }),
  },
  {
    key: "code",
    label: "Code presented",
    description:
      "A shared code everyone may use, or a unique code tied to a grant. Matched case- and whitespace-insensitively.",
    check(input) {
      const presented = input.presentedCodes.map(normaliseCode);

      if (input.exchange.acquisition.codeSharing === "unique") {
        const held = input.grants.find(
          (grant) => grant.code !== undefined && presented.includes(normaliseCode(grant.code)),
        );
        return held
          ? { passed: true, detail: `unique code accepted (grant ${held.id})` }
          : { passed: false, detail: "no matching unique code presented" };
      }

      const expected = input.exchange.acquisition.code;
      return expected !== undefined && presented.includes(normaliseCode(expected))
        ? { passed: true, detail: "shared code accepted" }
        : { passed: false, detail: "code not presented" };
    },
  },
  {
    key: "issued",
    label: "Issued in advance",
    description: "Granted to a named subject before the interaction. Subsidies, employee benefits.",
    requiresIdentifiedSubject: true,
    check: (input) => fromGrant(input, "issued"),
  },
  {
    key: "earned",
    label: "Earned",
    description: "Unlocked by meeting a condition, then held as a grant. Loyalty rewards.",
    requiresIdentifiedSubject: true,
    check: (input) => fromGrant(input, "earned"),
  },
  {
    key: "referred",
    label: "Obtained by referral",
    description: "Granted through another subject's referral.",
    requiresIdentifiedSubject: true,
    check: (input) => fromGrant(input, "referred"),
  },
];

export function acquisitionModeRegistry(): Registry<AcquisitionMode> {
  return new Registry<AcquisitionMode>("acquisition-mode").registerAll(DEFAULT_ACQUISITION_MODES);
}
