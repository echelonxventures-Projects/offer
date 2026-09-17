/**
 * Realities.
 *
 * A reality is the outermost partition of the platform: every decision, ledger
 * entry and audit record belongs to exactly one. Production is a reality.
 * So is a sandbox, a what-if simulation, a back-test over last quarter, a game
 * world, and a regulator's replay of a disputed redemption.
 *
 * The important flag is `effectsAreBinding`. When it is false the same engines
 * run, the same rules evaluate and the same trace is produced, but settlement
 * writes to a scratch ledger that is discarded. This is what makes the
 * simulation and forecasting capabilities honest: they are not a separate model
 * that drifts from production, they are production with the effects detached.
 */
import type { RegistryEntry } from "../../registry/registry.ts";
import { Registry } from "../../registry/registry.ts";

export interface Reality extends RegistryEntry {
  /** Do settlements in this reality move value that anyone will account for? */
  readonly effectsAreBinding: boolean;
  /** Chronology instants default to here. */
  readonly defaultChronology: string;
  /** Root of the spatial tree that is meaningful here. */
  readonly spatialRoot?: string;
  /** If set, only these unit classes may be transacted in this reality. */
  readonly allowedUnitClasses?: readonly string[];
  /** Reality this one was branched from; a simulation names its production. */
  readonly derivedFrom?: string;
}

export const REALITY_PRODUCTION = "production";
export const REALITY_SANDBOX = "sandbox";
export const REALITY_SIMULATION = "simulation";

export const DEFAULT_REALITIES: Reality[] = [
  {
    key: REALITY_PRODUCTION,
    label: "Production",
    description: "Binding. Real money, real liabilities, real audit obligations.",
    effectsAreBinding: true,
    defaultChronology: "earth.unix.ms",
    spatialRoot: "sol",
  },
  {
    key: REALITY_SANDBOX,
    label: "Sandbox",
    description: "Integration testing for tenants. Non-binding, persistent.",
    effectsAreBinding: false,
    defaultChronology: "earth.unix.ms",
    spatialRoot: "sol",
    derivedFrom: REALITY_PRODUCTION,
  },
  {
    key: REALITY_SIMULATION,
    label: "Simulation",
    description: "What-if and back-test runs. Non-binding, discarded after the run.",
    effectsAreBinding: false,
    defaultChronology: "earth.unix.ms",
    spatialRoot: "sol",
    derivedFrom: REALITY_PRODUCTION,
  },
];

export function realityRegistry(): Registry<Reality> {
  return new Registry<Reality>("reality").registerAll(DEFAULT_REALITIES);
}
