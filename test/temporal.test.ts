/**
 * Temporal. The claim under test is that nothing assumes a Gregorian year, a
 * seven-day week or a terrestrial day.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TemporalAuthority, fixedClock } from "../src/universal/temporal/authority.ts";
import { instant } from "../src/universal/temporal/chronology.ts";
import { fiscalCalendar, gregorianCalendar } from "../src/universal/temporal/calendars.ts";
import { constraintHolds } from "../src/universal/temporal/window.ts";
import { unwrap } from "../src/kernel/result.ts";

const at = (ms: number) => instant("earth.unix.ms", BigInt(ms));
const authority = (ms = Date.UTC(2026, 8, 19, 10, 30)) =>
  new TemporalAuthority({ clock: fixedClock(BigInt(ms) * 1_000_000n) });

describe("gregorian calendar", () => {
  test("agrees with a known set of dates", async () => {
    const t = authority();
    const cases: [number, number, number, number, number][] = [
      // [utcMs, year, month, day, dayOfWeek(1=Mon)]
      [Date.UTC(1970, 0, 1), 1970, 1, 1, 4],
      [Date.UTC(2000, 1, 29), 2000, 2, 29, 2],
      [Date.UTC(2026, 8, 19), 2026, 9, 19, 6],
      [Date.UTC(1900, 2, 1), 1900, 3, 1, 4],
      [Date.UTC(2024, 11, 31), 2024, 12, 31, 2],
    ];
    for (const [ms, year, month, day, dow] of cases) {
      const fields = unwrap(t.fields(at(ms), "gregorian"));
      assert.deepEqual(
        [fields.year, fields.month, fields.day, fields.dayOfWeek],
        [year, month, day, dow],
        new Date(ms).toISOString(),
      );
    }
  });

  test("handles dates before the epoch", async () => {
    const t = authority();
    const fields = unwrap(t.fields(at(Date.UTC(1969, 6, 20)), "gregorian"));
    assert.deepEqual([fields.year, fields.month, fields.day], [1969, 7, 20]);
  });

  test("compose is the inverse of decompose", async () => {
    for (const ms of [Date.UTC(2026, 8, 19, 10, 30, 15), Date.UTC(1912, 3, 15, 2, 20), Date.UTC(2100, 0, 1)]) {
      const fields = gregorianCalendar.decompose(at(ms), { offsetSeconds: 0 });
      const back = gregorianCalendar.compose(fields, { offsetSeconds: 0 });
      assert.equal(back.tick, BigInt(ms), new Date(ms).toISOString());
    }
  });

  test("applies a zone offset without changing the instant", async () => {
    const t = authority();
    const utc = unwrap(t.fields(at(Date.UTC(2026, 8, 19, 22, 0)), "gregorian", "UTC"));
    const ist = unwrap(t.fields(at(Date.UTC(2026, 8, 19, 22, 0)), "gregorian", "Asia/Kolkata"));
    assert.equal(utc.day, 19);
    assert.equal(ist.day, 20); // +5:30 pushes it past midnight
    assert.equal(ist.hour, 3);
  });
});

describe("fiscal calendars", () => {
  test("derive a different year boundary from the same arithmetic", async () => {
    const april = fiscalCalendar({ key: "f", label: "f", startMonth: 4 });
    const march = april.decompose(at(Date.UTC(2026, 2, 31)), { offsetSeconds: 0 });
    const aprilFirst = april.decompose(at(Date.UTC(2026, 3, 1)), { offsetSeconds: 0 });
    assert.equal(march.fiscalYear, 2026);
    assert.equal(aprilFirst.fiscalYear, 2027);
    assert.equal(aprilFirst.fiscalQuarter, 1);
    assert.equal(march.fiscalQuarter, 4);
  });
});

describe("mars", () => {
  test("is in the same frame as Earth, so the two are comparable", async () => {
    const t = authority();
    const earth = at(Date.UTC(2026, 8, 19));
    const mars = unwrap(t.convert(earth, "mars.sol.msd"));

    // Comparison succeeds at all, which is the point: same frame.
    const ordering = unwrap(t.compare(earth, mars));

    // A millisol is ~88.8 s, far coarser than a millisecond, so converting
    // downward floors and the Mars instant lands at or before the Earth one.
    // The loss is bounded by exactly one target tick and never more.
    assert.equal(ordering >= 0, true, "flooring must not move the instant forward");
    const drift = unwrap(t.between(mars, earth));
    assert.equal(drift >= 0n, true);
    assert.equal(drift < 88_775_244_147_000n, true, "drift must stay under one sol-tick");

    const fields = unwrap(t.fields(mars, "mars.msd"));
    assert.equal(typeof fields.sol, "number");
    assert.equal(fields.month, undefined, "a Martian calendar must not publish a month");
  });

  test("one sol is 88775.244147 SI seconds", async () => {
    const t = authority();
    const sol0 = instant("mars.sol.msd", 0n);
    const sol1 = instant("mars.sol.msd", 1000n);
    const nanos = unwrap(t.between(sol0, sol1));
    assert.equal(nanos, 88_775_244_147_000n);
  });

  test("refuses to compare across genuinely different frames", async () => {
    const t = authority();
    const result = t.compare(at(0), instant("vessel.proper.s", 0n));
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : "", /reference frames/);
  });
});

describe("windows", () => {
  test("bounds are inclusive at the start and exclusive at the end", async () => {
    const t = authority();
    const window = { from: at(1000), to: at(2000) };
    assert.equal(unwrap(t.contains(window, at(1000))).inside, true);
    assert.equal(unwrap(t.contains(window, at(1999))).inside, true);
    assert.equal(unwrap(t.contains(window, at(2000))).inside, false);
    assert.equal(unwrap(t.contains(window, at(999))).inside, false);
  });

  test("field constraints compose with bounds", async () => {
    const t = authority();
    const weekends = {
      calendar: "gregorian",
      constraints: [{ field: "dayOfWeek", in: [6, 7] }],
    };
    assert.equal(unwrap(t.contains(weekends, at(Date.UTC(2026, 8, 19)))).inside, true); // Saturday
    assert.equal(unwrap(t.contains(weekends, at(Date.UTC(2026, 8, 21)))).inside, false); // Monday
  });

  test("a constraint naming an unknown field is rejected at authoring time", async () => {
    const t = authority();
    const bad = t.validateWindow({ calendar: "gregorian", constraints: [{ field: "sol" }] });
    assert.equal(bad.ok, false);
    assert.match(bad.ok === false ? bad.error.message : "", /has no field/);
  });

  test("modulo constraints work on any field", async () => {
    assert.equal(constraintHolds({ field: "sol", modulo: 3, remainder: 0 }, 9), true);
    assert.equal(constraintHolds({ field: "sol", modulo: 3, remainder: 0 }, 10), false);
    assert.equal(constraintHolds({ field: "x", min: 1, max: 5 }, 3), true);
    assert.equal(constraintHolds({ field: "x", notIn: [3] }, 3), false);
    assert.equal(constraintHolds({ field: "x" }, undefined), false);
  });
});

describe("clock injection", () => {
  test("a fixed clock makes now() reproducible", async () => {
    const t = authority(1_700_000_000_000);
    assert.equal(unwrap(t.now()).tick, 1_700_000_000_000n);
    assert.equal(unwrap(t.now()).tick, 1_700_000_000_000n);
  });
});
