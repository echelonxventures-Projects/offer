package main

import (
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strings"
)

// Amount is an exact integer count of minor units. Go has no native bigint, so
// this is *big.Int - and the spec has to be precise enough that the difference
// does not show.
type Amount struct {
	Unit  string
	Minor *big.Int
	Scale int
}

func newAmount(unit string, minor *big.Int, scale int) Amount {
	return Amount{Unit: unit, Minor: new(big.Int).Set(minor), Scale: scale}
}

var (
	zeroInt    = big.NewInt(0)
	oneInt     = big.NewInt(1)
	twoInt     = big.NewInt(2)
	tenInt     = big.NewInt(10)
	decimalRe  = regexp.MustCompile(`^(-)?(\d+)(?:\.(\d+))?$`)
	allZerosRe = regexp.MustCompile(`^0*$`)
)

func pow10(n int) *big.Int {
	return new(big.Int).Exp(tenInt, big.NewInt(int64(n)), nil)
}

// fromDecimal parses a human decimal at a unit's scale. More precision than the
// scale allows is an error, never a silent round - the reference throws here
// and so must every implementation.
func fromDecimal(unit, decimal string, scale int) (Amount, error) {
	match := decimalRe.FindStringSubmatch(strings.TrimSpace(decimal))
	if match == nil {
		return Amount{}, fmt.Errorf("'%s' is not a decimal number", decimal)
	}
	sign, whole, frac := match[1], match[2], match[3]

	padded := (frac + strings.Repeat("0", scale))
	if len(padded) > scale {
		padded = padded[:scale]
	}
	if len(frac) > scale {
		dropped := frac[scale:]
		if !allZerosRe.MatchString(dropped) {
			return Amount{}, fmt.Errorf("'%s' has more precision than unit scale %d allows", decimal, scale)
		}
	}

	minor, ok := new(big.Int).SetString(whole+padded, 10)
	if !ok {
		return Amount{}, fmt.Errorf("'%s' is not a decimal number", decimal)
	}
	if sign == "-" {
		minor.Neg(minor)
	}
	return Amount{Unit: unit, Minor: minor, Scale: scale}, nil
}

func (a Amount) toDecimal() string {
	negative := a.Minor.Sign() < 0
	digits := new(big.Int).Abs(a.Minor).String()
	for len(digits) < a.Scale+1 {
		digits = "0" + digits
	}
	whole := digits[:len(digits)-a.Scale]
	out := whole
	if a.Scale > 0 {
		out = whole + "." + digits[len(digits)-a.Scale:]
	}
	if negative {
		out = "-" + out
	}
	return out
}

// divideRound is the single rounding primitive. Every mode, over both signs.
//
// The magnitude is computed on absolute values and the sign reapplied, which is
// why "down"/"up" are toward and away from zero while "floor"/"ceiling" follow
// the number line.
func divideRound(numerator, denominator *big.Int, mode string) (*big.Int, error) {
	if denominator.Sign() == 0 {
		return nil, fmt.Errorf("division by zero")
	}
	negative := (numerator.Sign() < 0) != (denominator.Sign() < 0)

	n := new(big.Int).Abs(numerator)
	d := new(big.Int).Abs(denominator)
	q, r := new(big.Int).QuoRem(n, d, new(big.Int))

	if r.Sign() == 0 {
		if negative {
			return q.Neg(q), nil
		}
		return q, nil
	}

	twice := new(big.Int).Mul(r, twoInt)
	magnitude := new(big.Int).Set(q)
	bump := func() { magnitude.Add(magnitude, oneInt) }

	switch mode {
	case "down":
	case "up":
		bump()
	case "floor":
		if negative {
			bump()
		}
	case "ceiling":
		if !negative {
			bump()
		}
	case "half_up":
		if twice.Cmp(d) >= 0 {
			bump()
		}
	case "half_down":
		if twice.Cmp(d) > 0 {
			bump()
		}
	case "half_even":
		odd := new(big.Int).Mod(q, twoInt).Cmp(oneInt) == 0
		if twice.Cmp(d) > 0 || (twice.Cmp(d) == 0 && odd) {
			bump()
		}
	default:
		return nil, fmt.Errorf("unknown rounding mode '%s'", mode)
	}

	if negative {
		return magnitude.Neg(magnitude), nil
	}
	return magnitude, nil
}

// Rate is an exact rational. Percentages are rationals, never floats.
type Rate struct {
	Numerator   *big.Int
	Denominator *big.Int
}

// percentRate turns "12.5" into 125/1000, not into 0.125.
func percentRate(text string) (Rate, error) {
	decimals := 0
	if dot := strings.Index(text, "."); dot >= 0 {
		decimals = len(text) - dot - 1
	}
	numerator, ok := new(big.Int).SetString(strings.Replace(text, ".", "", 1), 10)
	if !ok {
		return Rate{}, fmt.Errorf("'%s' is not a percentage", text)
	}
	denominator := new(big.Int).Mul(big.NewInt(100), pow10(decimals))
	return Rate{Numerator: numerator, Denominator: denominator}, nil
}

func multiplyRate(a Amount, rate Rate, mode string) (Amount, error) {
	product := new(big.Int).Mul(a.Minor, rate.Numerator)
	minor, err := divideRound(product, rate.Denominator, mode)
	if err != nil {
		return Amount{}, err
	}
	return Amount{Unit: a.Unit, Minor: minor, Scale: a.Scale}, nil
}

func sameUnit(a, b Amount) error {
	if a.Unit != b.Unit {
		return fmt.Errorf("UNIT_MISMATCH")
	}
	if a.Scale != b.Scale {
		return fmt.Errorf("UNIT_MISMATCH")
	}
	return nil
}

func addAmounts(a, b Amount) (Amount, error) {
	if err := sameUnit(a, b); err != nil {
		return Amount{}, err
	}
	return Amount{Unit: a.Unit, Scale: a.Scale, Minor: new(big.Int).Add(a.Minor, b.Minor)}, nil
}

func subtractAmounts(a, b Amount) (Amount, error) {
	if err := sameUnit(a, b); err != nil {
		return Amount{}, err
	}
	return Amount{Unit: a.Unit, Scale: a.Scale, Minor: new(big.Int).Sub(a.Minor, b.Minor)}, nil
}

func compareAmounts(a, b Amount) (int, error) {
	if err := sameUnit(a, b); err != nil {
		return 0, err
	}
	return a.Minor.Cmp(b.Minor), nil
}

// allocate divides an amount by weight with nothing lost or created.
//
// The remainder ordering is normative: largest weight first, ties broken by
// index. It is what makes multi-party funding and attribution reconcilable, so
// an implementation that distributes differently is not conforming even though
// its parts also sum to the whole.
func allocate(a Amount, weights []*big.Int) ([]Amount, error) {
	if len(weights) == 0 {
		return nil, fmt.Errorf("INVALID_REQUEST: allocate() needs at least one weight")
	}
	total := new(big.Int)
	for _, w := range weights {
		if w.Sign() < 0 {
			return nil, fmt.Errorf("INVALID_REQUEST: allocate() weights must be non-negative")
		}
		total.Add(total, w)
	}
	if total.Sign() == 0 {
		return nil, fmt.Errorf("INVALID_REQUEST: allocate() weights must not sum to zero")
	}

	parts := make([]*big.Int, len(weights))
	assigned := new(big.Int)
	for i, w := range weights {
		share, err := divideRound(new(big.Int).Mul(a.Minor, w), total, "down")
		if err != nil {
			return nil, err
		}
		parts[i] = share
		assigned.Add(assigned, share)
	}

	remainder := new(big.Int).Sub(a.Minor, assigned)

	type slot struct {
		weight *big.Int
		index  int
	}
	order := make([]slot, len(weights))
	for i, w := range weights {
		order[i] = slot{weight: w, index: i}
	}
	sort.SliceStable(order, func(i, j int) bool {
		cmp := order[i].weight.Cmp(order[j].weight)
		if cmp == 0 {
			return order[i].index < order[j].index
		}
		return cmp > 0
	})

	step := big.NewInt(1)
	if remainder.Sign() < 0 {
		step = big.NewInt(-1)
	}
	cursor := 0
	for remainder.Sign() != 0 && len(order) > 0 {
		target := order[cursor%len(order)].index
		parts[target].Add(parts[target], step)
		remainder.Sub(remainder, step)
		cursor++
	}

	out := make([]Amount, len(parts))
	for i, minor := range parts {
		out[i] = Amount{Unit: a.Unit, Scale: a.Scale, Minor: minor}
	}
	return out, nil
}
