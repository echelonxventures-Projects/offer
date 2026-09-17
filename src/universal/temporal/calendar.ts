/**
 * Calendars.
 *
 * A calendar turns an instant into named integer *fields* and back. It does not
 * promise years, months or days: it publishes whichever fields it has, most
 * significant first, and rules refer to them by name. A Gregorian calendar
 * offers `year/month/day`; a Martian one offers `sol/millisol`; a fiscal one
 * offers `fiscalYear/fiscalQuarter/fiscalPeriod`. The eligibility engine treats
 * all three identically because it only ever reads `fields[name]`.
 */
import type { RegistryEntry } from "../../registry/registry.ts";
import { Registry } from "../../registry/registry.ts";
import type { Instant } from "./chronology.ts";

/** Named integer fields produced by a calendar for one instant. */
export type CalendarFields = Readonly<Record<string, number>>;

export interface ZoneOffset {
  /** Offset from the chronology's own reference, in seconds. */
  readonly offsetSeconds: number;
}

export interface Calendar extends RegistryEntry {
  /** Chronology this calendar reads. */
  readonly chronology: string;
  /** Field names, most significant first. Declared so rules can be validated. */
  readonly fieldNames: readonly string[];
  /** Instant to fields, in the given zone. */
  decompose(value: Instant, zone: ZoneOffset): CalendarFields;
  /** Fields back to an instant. Missing fields take their lowest legal value. */
  compose(fields: CalendarFields, zone: ZoneOffset): Instant;
}

/**
 * Zones are registry entries too. This ships fixed offsets only; a tenant that
 * needs political daylight-saving rules registers a zone-rule provider instead.
 * Documented as a known limitation rather than faked - see docs/04-registries.
 */
export interface TemporalZone extends RegistryEntry {
  readonly offsetSeconds: number;
}

export const DEFAULT_ZONES: TemporalZone[] = [
  { key: "UTC", label: "Coordinated Universal Time", offsetSeconds: 0 },
  { key: "Asia/Kolkata", label: "India Standard Time (UTC+5:30)", offsetSeconds: 19_800 },
  { key: "America/New_York:EST", label: "US Eastern Standard (UTC-5)", offsetSeconds: -18_000 },
  { key: "Europe/London:GMT", label: "Greenwich Mean Time", offsetSeconds: 0 },
  { key: "Mars/Airy", label: "Mars prime meridian", offsetSeconds: 0 },
];

export function calendarRegistry(): Registry<Calendar> {
  return new Registry<Calendar>("calendar");
}

export function zoneRegistry(): Registry<TemporalZone> {
  return new Registry<TemporalZone>("temporal-zone").registerAll(DEFAULT_ZONES);
}

export const UTC: ZoneOffset = { offsetSeconds: 0 };
