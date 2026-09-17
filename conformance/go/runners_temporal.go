package main

import (
	"encoding/json"
	"fmt"
	"math/big"
)

/* ------------------------- chronologies ------------------------- */

type chronology struct {
	key         string
	frame       string
	nanosNum    *big.Int
	nanosDen    *big.Int
	epochNanos  *big.Int
}

var chronologies = map[string]chronology{
	"earth.unix.ms": {key: "earth.unix.ms", frame: "si", nanosNum: big.NewInt(1_000_000), nanosDen: big.NewInt(1), epochNanos: big.NewInt(0)},
	"earth.unix.s":  {key: "earth.unix.s", frame: "si", nanosNum: big.NewInt(1_000_000_000), nanosDen: big.NewInt(1), epochNanos: big.NewInt(0)},
	"earth.unix.ns": {key: "earth.unix.ns", frame: "si", nanosNum: big.NewInt(1), nanosDen: big.NewInt(1), epochNanos: big.NewInt(0)},
	"mars.sol.msd": {
		key: "mars.sol.msd", frame: "si",
		nanosNum: big.NewInt(88_775_244_147_000), nanosDen: big.NewInt(1000),
		// MSD 0.0 is 1873-12-29T12:00:00Z.
		epochNanos: mustInt("-3029659200000000000"),
	},
}

func mustInt(text string) *big.Int {
	value, ok := new(big.Int).SetString(text, 10)
	if !ok {
		panic("bad integer literal " + text)
	}
	return value
}

var zones = map[string]int64{
	"UTC":                    0,
	"Asia/Kolkata":           19800,
	"America/New_York:EST":   -18000,
	"Europe/London:GMT":      0,
	"Mars/Airy":              0,
}

type instantValue struct {
	chronology string
	tick       *big.Int
}

func toFrameNanos(v instantValue) (*big.Int, error) {
	c, ok := chronologies[v.chronology]
	if !ok {
		return nil, fmt.Errorf("unknown chronology %q", v.chronology)
	}
	product := new(big.Int).Mul(v.tick, c.nanosNum)
	scaled, err := divideRound(product, c.nanosDen, "floor")
	if err != nil {
		return nil, err
	}
	return new(big.Int).Add(c.epochNanos, scaled), nil
}

func fromFrameNanos(nanos *big.Int, target string) (instantValue, error) {
	c, ok := chronologies[target]
	if !ok {
		return instantValue{}, fmt.Errorf("unknown chronology %q", target)
	}
	offset := new(big.Int).Sub(nanos, c.epochNanos)
	tick, err := divideRound(new(big.Int).Mul(offset, c.nanosDen), c.nanosNum, "floor")
	if err != nil {
		return instantValue{}, err
	}
	return instantValue{chronology: target, tick: tick}, nil
}

/* --------------------------- calendars --------------------------- */

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

func floorMod(a, b int64) int64 {
	m := a % b
	if m != 0 && (m < 0) != (b < 0) {
		m += b
	}
	return m
}

// civilFromDays is Howard Hinnant's algorithm. Implementing it rather than
// calling Go's time package is deliberate: the specification defines a
// proleptic Gregorian calendar, not "whatever the host language's date type
// does", and the two differ before 1583.
func civilFromDays(z int64) (year, month, day int64) {
	z += 719468
	era := floorDiv(z, 146097)
	doe := z - era*146097
	yoe := (doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096)) / 365
	y := yoe + era*400
	doy := doe - (365*yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100))
	mp := (5*doy + 2) / 153
	day = doy - (153*mp+2)/5 + 1
	if mp < 10 {
		month = mp + 3
	} else {
		month = mp - 9
	}
	if month <= 2 {
		y++
	}
	return y, month, day
}

func daysFromCivil(year, month, day int64) int64 {
	y := year
	if month <= 2 {
		y--
	}
	era := floorDiv(y, 400)
	yoe := y - era*400
	var mp int64
	if month > 2 {
		mp = month - 3
	} else {
		mp = month + 9
	}
	doy := (153*mp+2)/5 + day - 1
	doe := yoe*365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy
	return era*146097 + doe - 719468
}

const (
	msPerSecond = int64(1000)
	msPerMinute = int64(60000)
	msPerHour   = int64(3600000)
	msPerDay    = int64(86400000)
)

func gregorianFields(tick int64, offsetSeconds int64) map[string]any {
	local := tick + offsetSeconds*msPerSecond
	days := floorDiv(local, msPerDay)
	msOfDay := floorMod(local, msPerDay)
	year, month, day := civilFromDays(days)
	startOfYear := daysFromCivil(year, 1, 1)

	return map[string]any{
		"year":      json.Number(fmt.Sprint(year)),
		"month":     json.Number(fmt.Sprint(month)),
		"day":       json.Number(fmt.Sprint(day)),
		"hour":      json.Number(fmt.Sprint(floorDiv(msOfDay, msPerHour))),
		"minute":    json.Number(fmt.Sprint(floorMod(floorDiv(msOfDay, msPerMinute), 60))),
		"second":    json.Number(fmt.Sprint(floorMod(floorDiv(msOfDay, msPerSecond), 60))),
		"dayOfWeek": json.Number(fmt.Sprint(floorMod(days+3, 7) + 1)),
		"dayOfYear": json.Number(fmt.Sprint(days - startOfYear + 1)),
		"quarter":   json.Number(fmt.Sprint((month-1)/3 + 1)),
	}
}

// fiscalFields derives a fiscal calendar from the Gregorian one rather than
// reimplementing the arithmetic - the same composition the reference uses.
func fiscalFields(tick int64, offsetSeconds int64, startMonth int64, labelByStartYear bool) map[string]any {
	fields := gregorianFields(tick, offsetSeconds)
	month := numberOf(fields["month"])
	year := numberOf(fields["year"])

	offset := ((month - startMonth) + 12) % 12
	opensInYear := year
	if month < startMonth {
		opensInYear = year - 1
	}
	fiscalYear := opensInYear
	if !labelByStartYear {
		fiscalYear = opensInYear + 1
	}
	fields["fiscalYear"] = json.Number(fmt.Sprint(fiscalYear))
	fields["fiscalMonth"] = json.Number(fmt.Sprint(offset + 1))
	fields["fiscalQuarter"] = json.Number(fmt.Sprint(offset/3 + 1))
	return fields
}

// marsFields publishes sols and millisols. There is no month and no week, and
// no rule written against this calendar may assume one.
func marsFields(tick int64) map[string]any {
	sol := floorDiv(tick, 1000)
	millisol := floorMod(tick, 1000)
	marsYear := floorDiv(sol*10, 6686)
	solOfYear := sol - floorDiv(marsYear*6686, 10)
	return map[string]any{
		"sol":       json.Number(fmt.Sprint(sol)),
		"millisol":  json.Number(fmt.Sprint(millisol)),
		"marsYear":  json.Number(fmt.Sprint(marsYear)),
		"solOfYear": json.Number(fmt.Sprint(solOfYear)),
	}
}

func numberOf(value any) int64 {
	if n, ok := value.(json.Number); ok {
		if i, err := n.Int64(); err == nil {
			return i
		}
	}
	return 0
}

func calendarFields(calendar string, v instantValue, zone string) (map[string]any, error) {
	offset, ok := zones[zone]
	if !ok {
		offset = 0
	}

	target := "earth.unix.ms"
	if calendar == "mars.msd" {
		target = "mars.sol.msd"
	}
	if v.chronology != target {
		nanos, err := toFrameNanos(v)
		if err != nil {
			return nil, err
		}
		converted, err := fromFrameNanos(nanos, target)
		if err != nil {
			return nil, err
		}
		v = converted
	}

	switch calendar {
	case "gregorian":
		return gregorianFields(v.tick.Int64(), offset), nil
	case "fiscal.in":
		return fiscalFields(v.tick.Int64(), offset, 4, false), nil
	case "fiscal.us-federal":
		return fiscalFields(v.tick.Int64(), offset, 10, false), nil
	case "mars.msd":
		return marsFields(v.tick.Int64()), nil
	}
	return nil, fmt.Errorf("unknown calendar %q", calendar)
}

func readInstant(raw any) (instantValue, error) {
	asMap, ok := raw.(map[string]any)
	if !ok {
		return instantValue{}, fmt.Errorf("not an instant")
	}
	tick, ok := newIntFromString(str(asMap, "tick"))
	if !ok {
		return instantValue{}, fmt.Errorf("bad tick")
	}
	return instantValue{chronology: str(asMap, "chronology"), tick: tick}, nil
}

func init() {
	runners["temporal"] = func(_ *vectorSuite, _ vectorCase, input map[string]any) (map[string]any, error) {
		switch str(input, "op") {
		case "convert":
			from, err := readInstant(input["from"])
			if err != nil {
				return nil, err
			}
			nanos, err := toFrameNanos(from)
			if err != nil {
				return nil, err
			}
			converted, err := fromFrameNanos(nanos, str(input, "to"))
			if err != nil {
				return nil, err
			}
			fields, err := calendarFields("mars.msd", converted, "UTC")
			if err != nil {
				return nil, err
			}
			return map[string]any{
				"instant": map[string]any{"chronology": converted.chronology, "tick": converted.tick.String()},
				"fields":  fields,
			}, nil

		case "contains":
			window, _ := input["window"].(map[string]any)
			at, err := readInstant(input["instant"])
			if err != nil {
				return nil, err
			}
			verdict, err := windowContains(window, at)
			if err != nil {
				return nil, err
			}
			return map[string]any{"verdict": verdict}, nil
		}

		at, err := readInstant(input["instant"])
		if err != nil {
			return nil, err
		}
		fields, err := calendarFields(str(input, "calendar"), at, str(input, "zone"))
		if err != nil {
			return nil, err
		}
		return map[string]any{"fields": fields}, nil
	}
}

// windowContains: start inclusive, end exclusive, then field constraints.
func windowContains(window map[string]any, at instantValue) (map[string]any, error) {
	atNanos, err := toFrameNanos(at)
	if err != nil {
		return nil, err
	}

	if raw, ok := window["from"]; ok && raw != nil {
		from, err := readInstant(raw)
		if err != nil {
			return nil, err
		}
		fromNanos, err := toFrameNanos(from)
		if err != nil {
			return nil, err
		}
		if atNanos.Cmp(fromNanos) < 0 {
			return map[string]any{"inside": false, "reason": "before window start"}, nil
		}
	}
	if raw, ok := window["to"]; ok && raw != nil {
		to, err := readInstant(raw)
		if err != nil {
			return nil, err
		}
		toNanos, err := toFrameNanos(to)
		if err != nil {
			return nil, err
		}
		if atNanos.Cmp(toNanos) >= 0 {
			return map[string]any{"inside": false, "reason": "at or after window end"}, nil
		}
	}

	constraints, _ := window["constraints"].([]any)
	if len(constraints) == 0 {
		return map[string]any{"inside": true}, nil
	}

	calendar := str(window, "calendar")
	zone := str(window, "zone")
	if zone == "" {
		zone = "UTC"
	}
	fields, err := calendarFields(calendar, at, zone)
	if err != nil {
		return nil, err
	}

	for _, raw := range constraints {
		constraint, _ := raw.(map[string]any)
		field := str(constraint, "field")
		value, present := fields[field]
		if !present || !constraintHolds(constraint, numberOf(value)) {
			return map[string]any{"inside": false, "reason": fmt.Sprintf("calendar field '%s' outside constraint", field)}, nil
		}
	}
	return map[string]any{"inside": true}, nil
}

func constraintHolds(constraint map[string]any, value int64) bool {
	if allowed, ok := constraint["in"].([]any); ok {
		found := false
		for _, entry := range allowed {
			if numberOf(entry) == value {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if forbidden, ok := constraint["notIn"].([]any); ok {
		for _, entry := range forbidden {
			if numberOf(entry) == value {
				return false
			}
		}
	}
	if raw, ok := constraint["min"]; ok && value < numberOf(raw) {
		return false
	}
	if raw, ok := constraint["max"]; ok && value > numberOf(raw) {
		return false
	}
	if raw, ok := constraint["modulo"]; ok {
		modulo := numberOf(raw)
		remainder := int64(0)
		if r, ok := constraint["remainder"]; ok {
			remainder = numberOf(r)
		}
		if modulo != 0 && floorMod(value, modulo) != remainder {
			return false
		}
	}
	return true
}
