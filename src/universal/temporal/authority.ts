/**
 * Temporal Authority.
 *
 * Every question about time goes through here: what is now, is this instant
 * inside that window, what are the calendar fields, how far apart are two
 * instants. Engines hold a `TemporalAuthority`, never a `Date`.
 *
 * The clock is injected. That is not testing pedantry - a platform that decides
 * eligibility from ambient wall-clock time cannot replay a disputed decision,
 * and replay is the whole value of the audit chain.
 */
import type { Result } from "../../kernel/result.ts";
import { fail, ok } from "../../kernel/result.ts";
import { ErrorCode } from "../../kernel/errors.ts";
import type { Registry } from "../../registry/registry.ts";
import type { Chronology, Instant } from "./chronology.ts";
import { chronologyRegistry, fromFrameNanos, toFrameNanos } from "./chronology.ts";
import type { Calendar, CalendarFields, TemporalZone, ZoneOffset } from "./calendar.ts";
import { UTC, calendarRegistry, zoneRegistry } from "./calendar.ts";
import { DEFAULT_CALENDARS } from "./calendars.ts";
import type { FieldConstraint, TemporalWindow } from "./window.ts";
import { constraintHolds } from "./window.ts";

/** The only source of wall-clock time in the platform. */
export interface Clock {
  /** Nanoseconds since the Unix epoch in the Earth SI frame. */
  nowNanos(): bigint;
}

export const systemClock: Clock = {
  nowNanos: () => BigInt(Date.now()) * 1_000_000n,
};

/** A clock that does not move unless you move it. Used by tests and replays. */
export function fixedClock(startNanos: bigint): Clock & { advance(nanos: bigint): void; set(nanos: bigint): void } {
  let current = startNanos;
  return {
    nowNanos: () => current,
    advance: (nanos) => {
      current += nanos;
    },
    set: (nanos) => {
      current = nanos;
    },
  };
}

export const DEFAULT_CHRONOLOGY = "earth.unix.ms";

export class TemporalAuthority {
  readonly chronologies: Registry<Chronology>;
  readonly calendars: Registry<Calendar>;
  readonly zones: Registry<TemporalZone>;
  readonly clock: Clock;

  constructor(options?: {
    clock?: Clock;
    chronologies?: Registry<Chronology>;
    calendars?: Registry<Calendar>;
    zones?: Registry<TemporalZone>;
  }) {
    this.clock = options?.clock ?? systemClock;
    this.chronologies = options?.chronologies ?? chronologyRegistry();
    this.calendars = options?.calendars ?? calendarRegistry().registerAll(DEFAULT_CALENDARS);
    this.zones = options?.zones ?? zoneRegistry();
  }

  now(chronologyKey: string = DEFAULT_CHRONOLOGY): Result<Instant> {
    const chronology = this.chronologies.require(chronologyKey);
    if (!chronology.ok) return chronology;
    return ok(fromFrameNanos(this.clock.nowNanos(), chronology.value));
  }

  zoneOffset(zoneKey: string | undefined): Result<ZoneOffset> {
    if (zoneKey === undefined) return ok(UTC);
    const zone = this.zones.require(zoneKey);
    return zone.ok ? ok({ offsetSeconds: zone.value.offsetSeconds }) : zone;
  }

  /** Decompose an instant into named calendar fields. */
  fields(value: Instant, calendarKey: string, zoneKey?: string): Result<CalendarFields> {
    const calendar = this.calendars.require(calendarKey);
    if (!calendar.ok) return calendar;
    if (calendar.value.chronology !== value.chronology) {
      const converted = this.convert(value, calendar.value.chronology);
      if (!converted.ok) return converted;
      value = converted.value;
    }
    const zone = this.zoneOffset(zoneKey);
    if (!zone.ok) return zone;
    return ok(calendar.value.decompose(value, zone.value));
  }

  /**
   * Re-express an instant in another chronology of the same frame.
   *
   * Lossy when the target tick is coarser than the source: converting Unix
   * milliseconds to millisols (~88.8 s each) truncates toward the past, and the
   * error is bounded by one target tick. Round-tripping is therefore not an
   * identity, which is why stored instants keep their original chronology and
   * conversion happens only at the point of comparison.
   */
  convert(value: Instant, toChronologyKey: string): Result<Instant> {
    if (value.chronology === toChronologyKey) return ok(value);
    const from = this.chronologies.require(value.chronology);
    if (!from.ok) return from;
    const to = this.chronologies.require(toChronologyKey);
    if (!to.ok) return to;
    if (from.value.frame !== to.value.frame) {
      return fail(
        ErrorCode.INVALID_REQUEST,
        `chronologies '${value.chronology}' and '${toChronologyKey}' are in different frames`,
        { fromFrame: from.value.frame, toFrame: to.value.frame },
      );
    }
    return ok(fromFrameNanos(toFrameNanos(value, from.value), to.value));
  }

  compare(a: Instant, b: Instant): Result<-1 | 0 | 1> {
    const nanos = this.bothInFrameNanos(a, b);
    if (!nanos.ok) return nanos;
    const [left, right] = nanos.value;
    return ok(left < right ? -1 : left > right ? 1 : 0);
  }

  /** Signed distance in frame nanoseconds. */
  between(a: Instant, b: Instant): Result<bigint> {
    const nanos = this.bothInFrameNanos(a, b);
    if (!nanos.ok) return nanos;
    const [left, right] = nanos.value;
    return ok(right - left);
  }

  plus(value: Instant, ticks: bigint): Instant {
    return { chronology: value.chronology, tick: value.tick + ticks };
  }

  /** Is this instant inside the window, including its field constraints? */
  contains(window: TemporalWindow, value: Instant): Result<{ inside: boolean; reason?: string }> {
    if (window.from) {
      const cmp = this.compare(value, window.from);
      if (!cmp.ok) return cmp;
      if (cmp.value < 0) return ok({ inside: false, reason: "before window start" });
    }
    if (window.to) {
      const cmp = this.compare(value, window.to);
      if (!cmp.ok) return cmp;
      if (cmp.value >= 0) return ok({ inside: false, reason: "at or after window end" });
    }
    if (!window.constraints || window.constraints.length === 0) return ok({ inside: true });

    if (!window.calendar) {
      return fail(ErrorCode.INVALID_REQUEST, "window has field constraints but names no calendar");
    }
    const fields = this.fields(value, window.calendar, window.zone);
    if (!fields.ok) return fields;

    for (const constraint of window.constraints) {
      if (!constraintHolds(constraint, fields.value[constraint.field])) {
        return ok({ inside: false, reason: `calendar field '${constraint.field}' outside constraint` });
      }
    }
    return ok({ inside: true });
  }

  /** Validate that a window's constraints name fields its calendar publishes. */
  validateWindow(window: TemporalWindow): Result<true> {
    if (!window.constraints?.length) return ok(true);
    const calendar = this.calendars.require(window.calendar ?? "");
    if (!calendar.ok) return calendar;
    const unknown = window.constraints
      .map((c: FieldConstraint) => c.field)
      .filter((f) => !calendar.value.fieldNames.includes(f));
    if (unknown.length > 0) {
      return fail(ErrorCode.INVALID_REQUEST, `calendar '${calendar.value.key}' has no field(s): ${unknown.join(", ")}`, {
        calendar: calendar.value.key,
        unknownFields: unknown,
        available: calendar.value.fieldNames,
      });
    }
    return ok(true);
  }

  private bothInFrameNanos(a: Instant, b: Instant): Result<[bigint, bigint]> {
    const ca = this.chronologies.require(a.chronology);
    if (!ca.ok) return ca;
    const cb = this.chronologies.require(b.chronology);
    if (!cb.ok) return cb;
    if (ca.value.frame !== cb.value.frame) {
      return fail(ErrorCode.INVALID_REQUEST, "cannot compare instants across reference frames", {
        frames: [ca.value.frame, cb.value.frame],
      });
    }
    return ok([toFrameNanos(a, ca.value), toFrameNanos(b, cb.value)]);
  }
}
