/**
 * Shipped calendar implementations.
 *
 * Three are enough to prove the abstraction is real: a civil calendar with
 * irregular month lengths, a derived calendar that reuses another's arithmetic
 * with a different year boundary, and one on a different planet with a
 * different frame entirely. A fourth would teach nothing new.
 */
import type { Calendar, CalendarFields, ZoneOffset } from "./calendar.ts";
import type { Instant } from "./chronology.ts";

const MS_PER_SECOND = 1000n;
const MS_PER_MINUTE = 60_000n;
const MS_PER_HOUR = 3_600_000n;
const MS_PER_DAY = 86_400_000n;

/** Floor division that behaves correctly for negative numerators. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function floorMod(a: bigint, b: bigint): bigint {
  const m = a % b;
  return m !== 0n && m < 0n !== b < 0n ? m + b : m;
}

/**
 * Days-since-epoch to civil date (Howard Hinnant's algorithm), in bigint so it
 * stays exact for dates far outside the range anyone will actually use.
 */
function civilFromDays(z0: bigint): { year: bigint; month: bigint; day: bigint } {
  const z = z0 + 719_468n;
  const era = floorDiv(z, 146_097n);
  const doe = z - era * 146_097n;
  const yoe = (doe - floorDiv(doe, 1460n) + floorDiv(doe, 36_524n) - floorDiv(doe, 146_096n)) / 365n;
  const y = yoe + era * 400n;
  const doy = doe - (365n * yoe + floorDiv(yoe, 4n) - floorDiv(yoe, 100n));
  const mp = (5n * doy + 2n) / 153n;
  const day = doy - (153n * mp + 2n) / 5n + 1n;
  const month = mp < 10n ? mp + 3n : mp - 9n;
  return { year: month <= 2n ? y + 1n : y, month, day };
}

function daysFromCivil(year: bigint, month: bigint, day: bigint): bigint {
  const y = month <= 2n ? year - 1n : year;
  const era = floorDiv(y, 400n);
  const yoe = y - era * 400n;
  const mp = month > 2n ? month - 3n : month + 9n;
  const doy = (153n * mp + 2n) / 5n + day - 1n;
  const doe = yoe * 365n + floorDiv(yoe, 4n) - floorDiv(yoe, 100n) + doy;
  return era * 146_097n + doe - 719_468n;
}

const num = (b: bigint): number => Number(b);

/** Proleptic Gregorian over `earth.unix.ms`. */
export const gregorianCalendar: Calendar = {
  key: "gregorian",
  label: "Gregorian calendar",
  description: "Proleptic Gregorian civil calendar over Unix milliseconds.",
  chronology: "earth.unix.ms",
  fieldNames: ["year", "month", "day", "hour", "minute", "second", "dayOfWeek", "dayOfYear", "quarter"],

  decompose(value: Instant, zone: ZoneOffset): CalendarFields {
    const local = value.tick + BigInt(zone.offsetSeconds) * MS_PER_SECOND;
    const days = floorDiv(local, MS_PER_DAY);
    const msOfDay = floorMod(local, MS_PER_DAY);
    const { year, month, day } = civilFromDays(days);
    const startOfYear = daysFromCivil(year, 1n, 1n);
    return {
      year: num(year),
      month: num(month),
      day: num(day),
      hour: num(floorDiv(msOfDay, MS_PER_HOUR)),
      minute: num(floorMod(floorDiv(msOfDay, MS_PER_MINUTE), 60n)),
      second: num(floorMod(floorDiv(msOfDay, MS_PER_SECOND), 60n)),
      // 1 = Monday .. 7 = Sunday. 1970-01-01 was a Thursday.
      dayOfWeek: num(floorMod(days + 3n, 7n)) + 1,
      dayOfYear: num(days - startOfYear) + 1,
      quarter: num((month - 1n) / 3n) + 1,
    };
  },

  compose(fields: CalendarFields, zone: ZoneOffset): Instant {
    const days = daysFromCivil(BigInt(fields.year ?? 1970), BigInt(fields.month ?? 1), BigInt(fields.day ?? 1));
    const ms =
      days * MS_PER_DAY +
      BigInt(fields.hour ?? 0) * MS_PER_HOUR +
      BigInt(fields.minute ?? 0) * MS_PER_MINUTE +
      BigInt(fields.second ?? 0) * MS_PER_SECOND +
      BigInt(fields.millisecond ?? 0);
    return { chronology: "earth.unix.ms", tick: ms - BigInt(zone.offsetSeconds) * MS_PER_SECOND };
  },
};

/**
 * A fiscal calendar is the Gregorian one with the year boundary moved. Building
 * it by composition rather than by copying is the whole point: a tenant with an
 * April-start fiscal year registers one of these and every existing rule that
 * reads `fiscalQuarter` starts working.
 */
export function fiscalCalendar(params: {
  key: string;
  label: string;
  /** Gregorian month (1-12) on which the fiscal year opens. */
  startMonth: number;
  /** Does the fiscal year take the name of the calendar year it opens in? */
  labelByStartYear?: boolean;
}): Calendar {
  const { key, label, startMonth, labelByStartYear = false } = params;
  return {
    key,
    label,
    description: `Fiscal calendar opening on Gregorian month ${startMonth}.`,
    chronology: "earth.unix.ms",
    fieldNames: ["fiscalYear", "fiscalQuarter", "fiscalMonth", "year", "month", "day"],
    decompose(value, zone) {
      const g = gregorianCalendar.decompose(value, zone);
      const gMonth = g.month as number;
      const gYear = g.year as number;
      const offset = (gMonth - startMonth + 12) % 12;
      const opensInYear = gMonth >= startMonth ? gYear : gYear - 1;
      return {
        ...g,
        fiscalYear: labelByStartYear ? opensInYear : opensInYear + 1,
        fiscalMonth: offset + 1,
        fiscalQuarter: Math.floor(offset / 3) + 1,
      };
    },
    compose(fields, zone) {
      return gregorianCalendar.compose(fields, zone);
    },
  };
}

/**
 * Mars Sol Date over the Mars frame. Fields are sols and millisols; there is no
 * month and no week, and no rule written against this calendar may assume one.
 */
export const marsSolCalendar: Calendar = {
  key: "mars.msd",
  label: "Mars Sol Date",
  description: "Sols and millisols. No months, no weeks - deliberately.",
  chronology: "mars.sol.msd",
  fieldNames: ["sol", "millisol", "marsYear", "solOfYear"],

  decompose(value: Instant): CalendarFields {
    const sol = floorDiv(value.tick, 1000n);
    const millisol = floorMod(value.tick, 1000n);
    // A Martian year is 668.5991 sols; 6686 sols per 10 Mars years keeps it exact.
    const marsYear = floorDiv(sol * 10n, 6686n);
    const solOfYear = sol - floorDiv(marsYear * 6686n, 10n);
    return {
      sol: num(sol),
      millisol: num(millisol),
      marsYear: num(marsYear),
      solOfYear: num(solOfYear),
    };
  },

  compose(fields: CalendarFields): Instant {
    return {
      chronology: "mars.sol.msd",
      tick: BigInt(fields.sol ?? 0) * 1000n + BigInt(fields.millisol ?? 0),
    };
  },
};

export const DEFAULT_CALENDARS: Calendar[] = [
  gregorianCalendar,
  marsSolCalendar,
  fiscalCalendar({ key: "fiscal.in", label: "Indian fiscal year (Apr-Mar)", startMonth: 4 }),
  fiscalCalendar({ key: "fiscal.us-federal", label: "US federal fiscal year (Oct-Sep)", startMonth: 10 }),
];
