/**
 * Chronologies.
 *
 * An `Instant` is a count of ticks since some epoch. What a tick is worth, and
 * where the epoch sits, are registry data. Two instants are comparable only if
 * their chronologies share a reference *frame*; comparing an Earth timestamp to
 * a ship-clock reading is a typed error, not a silent subtraction.
 *
 * Nothing in the platform calls `Date.now()`. Time enters through a `Clock`.
 */
import type { RegistryEntry } from "../../registry/registry.ts";
import { Registry } from "../../registry/registry.ts";
import type { Rate } from "../economic/amount.ts";
import { divideRound } from "../economic/amount.ts";

export interface Instant {
  /** Chronology key this tick count is expressed in. */
  readonly chronology: string;
  /** Exact tick count since the chronology's epoch. May be negative. */
  readonly tick: bigint;
}

export interface Chronology extends RegistryEntry {
  /**
   * Reference frame. Instants in different frames are not comparable without an
   * explicit, lossy transform that somebody has to authorise.
   */
  readonly frame: string;
  /** Exact nanoseconds per tick, as a rational so non-integer ticks stay exact. */
  readonly nanosPerTick: Rate;
  /** Frame nanoseconds from the frame origin to this chronology's epoch. */
  readonly epochNanos: bigint;
}

/**
 * The SI-second frame. Anything whose ticks are defined in SI seconds against a
 * shared origin belongs here, including Mars sols - a sol is 88775.244147 SI
 * seconds, so it is a different *epoch and tick size*, not a different frame.
 * Getting this boundary right is what makes an Earth instant and a Mars instant
 * legitimately comparable.
 */
export const FRAME_SI = "si";

/**
 * A worked example of a frame that genuinely is not comparable: proper time on
 * a relativistic vessel, where no fixed rate relates the clock to SI time. The
 * authority refuses to compare across it rather than inventing an answer.
 */
export const FRAME_PROPER_TIME = "proper-time";

const NANOS_PER_MILLI = 1_000_000n;
const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_SOL = 88_775_244_147_000n; // mean Martian solar day, in nanoseconds
/** MSD 0.0 is 1873-12-29T12:00:00Z. */
const MSD_EPOCH_NANOS = -3_029_659_200_000_000_000n;

export const DEFAULT_CHRONOLOGIES: Chronology[] = [
  {
    key: "earth.unix.ms",
    label: "Unix milliseconds",
    description: "Milliseconds since 1970-01-01T00:00:00Z. The platform default.",
    frame: FRAME_SI,
    nanosPerTick: { numerator: NANOS_PER_MILLI, denominator: 1n },
    epochNanos: 0n,
  },
  {
    key: "earth.unix.s",
    label: "Unix seconds",
    frame: FRAME_SI,
    nanosPerTick: { numerator: NANOS_PER_SECOND, denominator: 1n },
    epochNanos: 0n,
  },
  {
    key: "earth.unix.ns",
    label: "Unix nanoseconds",
    description: "For event streams that need sub-millisecond ordering.",
    frame: FRAME_SI,
    nanosPerTick: { numerator: 1n, denominator: 1n },
    epochNanos: 0n,
  },
  {
    key: "mars.sol.msd",
    label: "Mars Sol Date (millisols)",
    description: "Millisols since the MSD epoch. One sol is 88775.244147 SI seconds.",
    frame: FRAME_SI,
    nanosPerTick: { numerator: NANOS_PER_SOL, denominator: 1000n },
    epochNanos: MSD_EPOCH_NANOS,
  },
  {
    key: "vessel.proper.s",
    label: "Vessel proper seconds",
    description:
      "Seconds on a clock whose rate relative to SI time is not fixed. Present so " +
      "the cross-frame refusal path is exercised by a real entry, not a hypothetical.",
    frame: FRAME_PROPER_TIME,
    nanosPerTick: { numerator: NANOS_PER_SECOND, denominator: 1n },
    epochNanos: 0n,
  },
];

export function chronologyRegistry(): Registry<Chronology> {
  return new Registry<Chronology>("chronology").registerAll(DEFAULT_CHRONOLOGIES);
}

export const instant = (chronology: string, tick: bigint | number): Instant => ({
  chronology,
  tick: BigInt(tick),
});

/** Project an instant onto its frame's nanosecond axis for ordering and maths. */
export function toFrameNanos(value: Instant, chronology: Chronology): bigint {
  return (
    chronology.epochNanos +
    divideRound(value.tick * chronology.nanosPerTick.numerator, chronology.nanosPerTick.denominator, "floor")
  );
}

/** Inverse of `toFrameNanos`. */
export function fromFrameNanos(nanos: bigint, chronology: Chronology): Instant {
  const offset = nanos - chronology.epochNanos;
  return {
    chronology: chronology.key,
    tick: divideRound(offset * chronology.nanosPerTick.denominator, chronology.nanosPerTick.numerator, "floor"),
  };
}
