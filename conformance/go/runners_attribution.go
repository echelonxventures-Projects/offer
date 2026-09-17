package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"sort"
)

// weighForModel returns one weight per touchpoint. Weights need not be
// normalised; the split does that exactly.
func weighForModel(model string, n int) ([]float64, error) {
	weights := make([]float64, n)
	switch model {
	case "last_touch":
		if n > 0 {
			weights[n-1] = 1
		}
	case "first_touch":
		if n > 0 {
			weights[0] = 1
		}
	case "linear":
		for i := range weights {
			weights[i] = 1
		}
	case "position_based":
		switch {
		case n == 0:
		case n == 1:
			weights[0] = 1
		case n == 2:
			weights[0], weights[1] = 1, 1
		default:
			middle := 20.0 / float64(n-2)
			for i := range weights {
				if i == 0 || i == n-1 {
					weights[i] = 40
				} else {
					weights[i] = middle
				}
			}
		}
	case "time_decay":
		for i := range weights {
			weights[i] = math.Pow(2, float64(i-(n-1)))
		}
	default:
		return nil, fmt.Errorf("unknown attribution model %q", model)
	}
	return weights, nil
}

// splitBasisPoints divides 10000 by weight, remainder to the largest weight
// first with ties broken by index - the same rule as `allocate`, deliberately.
func splitBasisPoints(scaled []*big.Int, total *big.Int) []int {
	raw := make([]int, len(scaled))
	assigned := 0
	for i, w := range scaled {
		share := new(big.Int).Quo(new(big.Int).Mul(w, big.NewInt(10000)), total)
		raw[i] = int(share.Int64())
		assigned += raw[i]
	}
	remainder := 10000 - assigned

	type slot struct {
		weight *big.Int
		index  int
	}
	order := make([]slot, len(scaled))
	for i, w := range scaled {
		order[i] = slot{weight: w, index: i}
	}
	sort.SliceStable(order, func(i, j int) bool {
		cmp := order[i].weight.Cmp(order[j].weight)
		if cmp == 0 {
			return order[i].index < order[j].index
		}
		return cmp > 0
	})

	cursor := 0
	for remainder > 0 && len(order) > 0 {
		raw[order[cursor%len(order)].index]++
		remainder--
		cursor++
	}
	return raw
}

func init() {
	runners["attribution"] = func(_ *vectorSuite, _ vectorCase, input map[string]any) (map[string]any, error) {
		model := str(input, "model")
		count := num(input, "touchpointCount")

		weights, err := weighForModel(model, count)
		if err != nil {
			return nil, err
		}
		if count == 0 {
			return map[string]any{"basisPoints": []any{}, "amounts": []any{}, "basisPointsSum": json.Number("0")}, nil
		}

		scaled := make([]*big.Int, len(weights))
		total := new(big.Int)
		for i, w := range weights {
			rounded := math.Round(w * 1_000_000)
			if rounded < 0 {
				rounded = 0
			}
			scaled[i] = big.NewInt(int64(rounded))
			total.Add(total, scaled[i])
		}
		if total.Sign() == 0 {
			return nil, fmt.Errorf("model %q gave every touchpoint zero weight", model)
		}

		basisPoints := splitBasisPoints(scaled, total)

		amounts := []any{}
		if raw, ok := input["value"]; ok {
			value, err := readAmount(raw)
			if err != nil {
				return nil, err
			}
			parts, err := allocate(value, scaled)
			if err != nil {
				return nil, err
			}
			for _, part := range parts {
				amounts = append(amounts, wireAmount(part))
			}
		}

		points := make([]any, len(basisPoints))
		sum := 0
		for i, bp := range basisPoints {
			points[i] = json.Number(fmt.Sprint(bp))
			sum += bp
		}
		return map[string]any{
			"basisPoints":    points,
			"amounts":        amounts,
			"basisPointsSum": json.Number(fmt.Sprint(sum)),
		}, nil
	}
}
