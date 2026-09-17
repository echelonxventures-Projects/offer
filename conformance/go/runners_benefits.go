package main

import (
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
)

type cartLine struct {
	id         string
	sku        string
	quantity   int64
	unitPrice  Amount
	categories []string
	merchant   string
}

func (l cartLine) total() Amount {
	return Amount{Unit: l.unitPrice.Unit, Scale: l.unitPrice.Scale,
		Minor: new(big.Int).Mul(l.unitPrice.Minor, big.NewInt(l.quantity))}
}

func readLines(raw any) ([]cartLine, error) {
	list, _ := raw.([]any)
	lines := make([]cartLine, 0, len(list))
	for _, entry := range list {
		asMap, ok := entry.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("cart line is not an object")
		}
		price, err := readAmount(asMap["unitPrice"])
		if err != nil {
			return nil, err
		}
		categories := []string{}
		if raw, ok := asMap["categories"].([]any); ok {
			for _, c := range raw {
				if text, ok := c.(string); ok {
					categories = append(categories, text)
				}
			}
		}
		lines = append(lines, cartLine{
			id:         str(asMap, "id"),
			sku:        str(asMap, "sku"),
			quantity:   int64(num(asMap, "quantity")),
			unitPrice:  price,
			categories: categories,
			merchant:   str(asMap, "merchant"),
		})
	}
	return lines, nil
}

type lineAllocation struct {
	lineID string
	amount Amount
}

// spread divides a computed value across the lines it came from, proportional
// to line totals. Allocations must sum exactly to the value: a refund months
// later reverses them line by line.
func spread(value Amount, lines []cartLine) ([]lineAllocation, error) {
	if len(lines) == 0 || value.Minor.Sign() == 0 {
		return nil, nil
	}
	weights := make([]*big.Int, len(lines))
	allZero := true
	for i, line := range lines {
		total := line.total().Minor
		if total.Sign() < 0 {
			weights[i] = big.NewInt(0)
		} else {
			weights[i] = new(big.Int).Set(total)
			if total.Sign() != 0 {
				allZero = false
			}
		}
	}
	out := make([]lineAllocation, len(lines))
	if allZero {
		for i, line := range lines {
			out[i] = lineAllocation{lineID: line.id, amount: Amount{Unit: value.Unit, Scale: value.Scale, Minor: big.NewInt(0)}}
		}
		return out, nil
	}
	parts, err := allocate(value, weights)
	if err != nil {
		return nil, err
	}
	for i, line := range lines {
		out[i] = lineAllocation{lineID: line.id, amount: parts[i]}
	}
	return out, nil
}

func paramString(params map[string]any, key string) (string, bool) {
	switch v := params[key].(type) {
	case string:
		return v, true
	case json.Number:
		return v.String(), true
	}
	return "", false
}

func computeBenefit(spec map[string]any, base Amount, lines []cartLine, unit string, scale int) (map[string]any, error) {
	params, _ := spec["params"].(map[string]any)
	benefitType := str(spec, "type")
	rounding := str(spec, "rounding")
	if rounding == "" {
		rounding = "half_even"
	}

	zero := Amount{Unit: unit, Scale: scale, Minor: big.NewInt(0)}
	result := func(value Amount, allocations []lineAllocation, detail string, grant map[string]any) map[string]any {
		wired := []any{}
		for _, a := range allocations {
			wired = append(wired, map[string]any{"lineId": a.lineID, "amount": wireAmount(a.amount)})
		}
		out := map[string]any{"value": wireAmount(value), "allocations": wired, "detail": detail}
		if grant != nil {
			out["grant"] = grant
		}
		return out
	}

	switch benefitType {
	case "percentage":
		rateText, _ := paramString(params, "rate")
		rate, err := percentRate(rateText)
		if err != nil {
			return nil, err
		}
		value, err := multiplyRate(base, rate, rounding)
		if err != nil {
			return nil, err
		}
		allocations, err := spread(value, lines)
		if err != nil {
			return nil, err
		}
		return result(value, allocations, fmt.Sprintf("%s%% of %s %s", rateText, base.toDecimal(), base.Unit), nil), nil

	case "flat":
		amountText, _ := paramString(params, "amount")
		requested, err := fromDecimal(unit, amountText, scale)
		if err != nil {
			return nil, err
		}
		bounded := requested
		note := ""
		if base.Unit == requested.Unit && requested.Minor.Cmp(base.Minor) > 0 && base.Minor.Sign() >= 0 {
			bounded = base
			note = " (limited to base)"
		}
		allocations, err := spread(bounded, lines)
		if err != nil {
			return nil, err
		}
		return result(bounded, allocations, fmt.Sprintf("flat %s %s%s", bounded.toDecimal(), bounded.Unit, note), nil), nil

	case "tiered":
		tiers, _ := params["tiers"].([]any)
		var best *Amount
		bestMin := new(big.Int)
		bestLabel := ""
		for _, raw := range tiers {
			tier, _ := raw.(map[string]any)
			minText, _ := paramString(tier, "min")
			threshold, err := fromDecimal(base.Unit, minText, base.Scale)
			if err != nil {
				return nil, err
			}
			if base.Minor.Cmp(threshold.Minor) < 0 {
				continue
			}
			if best != nil && bestMin.Cmp(threshold.Minor) > 0 {
				continue
			}
			var value Amount
			var label string
			if rateText, ok := paramString(tier, "rate"); ok {
				rate, err := percentRate(rateText)
				if err != nil {
					return nil, err
				}
				value, err = multiplyRate(base, rate, rounding)
				if err != nil {
					return nil, err
				}
				label = fmt.Sprintf("tier min %s at %s%%", minText, rateText)
			} else {
				amountText, _ := paramString(tier, "amount")
				value, err = fromDecimal(base.Unit, amountText, base.Scale)
				if err != nil {
					return nil, err
				}
				label = fmt.Sprintf("tier min %s flat %s", minText, amountText)
			}
			best = &value
			bestMin = threshold.Minor
			bestLabel = label
		}
		if best == nil {
			return result(zero, nil, "no tier threshold met", nil), nil
		}
		allocations, err := spread(*best, lines)
		if err != nil {
			return nil, err
		}
		return result(*best, allocations, bestLabel, nil), nil

	case "volume":
		tiers, _ := params["tiers"].([]any)
		quantity := int64(0)
		for _, line := range lines {
			quantity += line.quantity
		}
		var best *Amount
		bestMin := int64(-1)
		bestLabel := ""
		for _, raw := range tiers {
			tier, _ := raw.(map[string]any)
			minQuantity := int64(num(tier, "minQuantity"))
			if quantity < minQuantity {
				continue
			}
			if best != nil && bestMin > minQuantity {
				continue
			}
			var value Amount
			var label string
			var err error
			if rateText, ok := paramString(tier, "rate"); ok {
				rate, rerr := percentRate(rateText)
				if rerr != nil {
					return nil, rerr
				}
				value, err = multiplyRate(base, rate, rounding)
				if err != nil {
					return nil, err
				}
				label = fmt.Sprintf("%d items >= %d at %s%%", quantity, minQuantity, rateText)
			} else {
				amountText, _ := paramString(tier, "amount")
				value, err = fromDecimal(base.Unit, amountText, base.Scale)
				if err != nil {
					return nil, err
				}
				label = fmt.Sprintf("%d items >= %d flat %s", quantity, minQuantity, amountText)
			}
			best = &value
			bestMin = minQuantity
			bestLabel = label
		}
		if best == nil {
			return result(zero, nil, fmt.Sprintf("quantity %d met no tier", quantity), nil), nil
		}
		allocations, err := spread(*best, lines)
		if err != nil {
			return nil, err
		}
		return result(*best, allocations, bestLabel, nil), nil

	case "fixed_price":
		priceText, _ := paramString(params, "price")
		total := Amount{Unit: unit, Scale: scale, Minor: big.NewInt(0)}
		allocations := []lineAllocation{}
		for _, line := range lines {
			target, err := fromDecimal(line.unitPrice.Unit, priceText, line.unitPrice.Scale)
			if err != nil {
				return nil, err
			}
			perUnit, err := subtractAmounts(line.unitPrice, target)
			if err != nil {
				return nil, err
			}
			saved := big.NewInt(0)
			if perUnit.Minor.Sign() > 0 {
				saved = new(big.Int).Mul(perUnit.Minor, big.NewInt(line.quantity))
			}
			lineAmount := Amount{Unit: unit, Scale: scale, Minor: saved}
			allocations = append(allocations, lineAllocation{lineID: line.id, amount: lineAmount})
			total, err = addAmounts(total, lineAmount)
			if err != nil {
				return nil, err
			}
		}
		return result(total, allocations, fmt.Sprintf("each unit priced at %s", priceText), nil), nil

	case "free_quantity":
		buy := int64(num(params, "buy"))
		free := int64(num(params, "free"))
		if buy <= 0 || free <= 0 {
			return nil, fmt.Errorf("INVALID_REQUEST: 'free_quantity' needs positive 'buy' and 'free'")
		}
		type unitEntry struct {
			line  cartLine
			price *big.Int
			order int
		}
		units := []unitEntry{}
		for _, line := range lines {
			for i := int64(0); i < line.quantity; i++ {
				units = append(units, unitEntry{line: line, price: line.unitPrice.Minor, order: len(units)})
			}
		}
		sort.SliceStable(units, func(i, j int) bool { return units[i].price.Cmp(units[j].price) < 0 })

		groups := int64(len(units)) / (buy + free)
		freeCount := groups * free
		if freeCount > int64(len(units)) {
			freeCount = int64(len(units))
		}

		total := big.NewInt(0)
		perLine := map[string]*big.Int{}
		order := []string{}
		for i := int64(0); i < freeCount; i++ {
			entry := units[i]
			if _, seen := perLine[entry.line.id]; !seen {
				perLine[entry.line.id] = big.NewInt(0)
				order = append(order, entry.line.id)
			}
			perLine[entry.line.id].Add(perLine[entry.line.id], entry.price)
			total.Add(total, entry.price)
		}
		allocations := []lineAllocation{}
		for _, id := range order {
			allocations = append(allocations, lineAllocation{lineID: id, amount: Amount{Unit: unit, Scale: scale, Minor: perLine[id]}})
		}
		return result(Amount{Unit: unit, Scale: scale, Minor: total}, allocations,
			fmt.Sprintf("%d unit(s) free under buy %d get %d", freeCount, buy, free), nil), nil

	case "item_grant":
		sku, ok := paramString(params, "sku")
		if !ok {
			return nil, fmt.Errorf("INVALID_REQUEST: 'item_grant' needs a 'sku'")
		}
		quantity := int64(1)
		if raw, present := params["quantity"]; present {
			if n, ok := raw.(json.Number); ok {
				if i, err := n.Int64(); err == nil {
					quantity = i
				}
			}
		}
		unitValue := Amount{Unit: unit, Scale: scale, Minor: big.NewInt(0)}
		if valueText, ok := paramString(params, "value"); ok {
			parsed, err := fromDecimal(unit, valueText, scale)
			if err != nil {
				return nil, err
			}
			unitValue = parsed
		}
		value := Amount{Unit: unit, Scale: scale, Minor: new(big.Int).Mul(unitValue.Minor, big.NewInt(quantity))}
		return result(value, nil, fmt.Sprintf("grant %d x %s", quantity, sku),
			map[string]any{"sku": sku, "quantity": json.Number(fmt.Sprint(quantity))}), nil

	case "points_accrual":
		points := int64(num(params, "points"))
		per := int64(num(params, "per"))
		if per <= 0 {
			return nil, fmt.Errorf("INVALID_REQUEST: 'points_accrual' needs a positive 'per'")
		}
		wholeUnits := new(big.Int).Quo(base.Minor, pow10(base.Scale))
		earned := new(big.Int).Mul(new(big.Int).Quo(wholeUnits, big.NewInt(per)), big.NewInt(points))
		if earned.Sign() < 0 {
			earned = big.NewInt(0)
		}
		return result(Amount{Unit: unit, Scale: scale, Minor: earned}, nil,
			fmt.Sprintf("%d per %d of %s %s", points, per, base.toDecimal(), base.Unit), nil), nil
	}

	return nil, fmt.Errorf("UNKNOWN_REGISTRY_ENTRY: no entry '%s' in registry 'benefit-type'", benefitType)
}

func init() {
	runners["benefits"] = func(_ *vectorSuite, _ vectorCase, input map[string]any) (map[string]any, error) {
		spec, _ := input["spec"].(map[string]any)
		base, err := readAmount(input["base"])
		if err != nil {
			return nil, err
		}
		lines, err := readLines(input["lines"])
		if err != nil {
			return nil, err
		}
		return computeBenefit(spec, base, lines, str(input, "unit"), num(input, "scale"))
	}
}
