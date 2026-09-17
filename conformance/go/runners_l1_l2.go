package main

import (
	"encoding/json"
	"fmt"
	"math/big"
)

func newIntFromString(text string) (*big.Int, bool) {
	return new(big.Int).SetString(text, 10)
}

func init() {
	runners["canonical"] = func(_ *vectorSuite, _ vectorCase, input map[string]any) (map[string]any, error) {
		value, err := decodeJSON([]byte(str(input, "value")))
		if err != nil {
			return nil, err
		}
		form := canonicalize(value)
		return map[string]any{"canonical": form, "sha256": sha256Hex(form)}, nil
	}

	runners["codec"] = func(_ *vectorSuite, _ vectorCase, input map[string]any) (map[string]any, error) {
		value, err := decodeJSON([]byte(str(input, "encoded")))
		if err != nil {
			return nil, err
		}
		reEncoded, err := encodeJSON(value)
		if err != nil {
			return nil, err
		}
		return map[string]any{"reEncoded": reEncoded}, nil
	}

	runners["audit-chain"] = func(_ *vectorSuite, _ vectorCase, input map[string]any) (map[string]any, error) {
		drafts, ok := input["drafts"].([]any)
		if !ok {
			return nil, fmt.Errorf("drafts missing")
		}
		previousHash := str(input, "genesis")
		sealed := make([]any, 0, len(drafts))

		for i, encoded := range drafts {
			text, ok := encoded.(string)
			if !ok {
				return nil, fmt.Errorf("draft %d is not a string", i)
			}
			draft, err := decodeJSON([]byte(text))
			if err != nil {
				return nil, err
			}
			record, ok := draft.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("draft %d is not an object", i)
			}
			// Seal: the hashed body is the draft plus seq and previousHash.
			body := map[string]any{"seq": i, "previousHash": previousHash}
			for k, v := range record {
				body[k] = v
			}
			hash := chainHash(previousHash, body)
			sealed = append(sealed, map[string]any{"seq": i, "previousHash": previousHash, "hash": hash})
			previousHash = hash
		}
		return map[string]any{"sealed": sealed}, nil
	}

	runners["amount"] = runAmountCase
	runners["allocate"] = runAllocateCase
}

func runAmountCase(_ *vectorSuite, c vectorCase, input map[string]any) (map[string]any, error) {
	expect, _ := decodeToMap(c.Expect)
	expectsFailure := has(expect, "throws") || has(expect, "error")

	switch str(input, "op") {
	case "fromDecimal":
		amount, err := fromDecimal(str(input, "unit"), str(input, "decimal"), num(input, "scale"))
		if err != nil {
			if expectsFailure {
				return map[string]any{"throws": true}, nil
			}
			return nil, err
		}
		return map[string]any{"amount": wireAmount(amount), "toDecimal": amount.toDecimal()}, nil

	case "divideRound":
		numerator, _ := newIntFromString(str(input, "numerator"))
		denominator, _ := newIntFromString(str(input, "denominator"))
		result, err := divideRound(numerator, denominator, str(input, "mode"))
		if err != nil {
			return nil, err
		}
		return map[string]any{"result": result.String()}, nil

	case "multiplyRate":
		base, err := readAmount(input["amount"])
		if err != nil {
			return nil, err
		}
		rate, err := percentRate(str(input, "percent"))
		if err != nil {
			return nil, err
		}
		product, err := multiplyRate(base, rate, str(input, "mode"))
		if err != nil {
			return nil, err
		}
		return map[string]any{"amount": wireAmount(product)}, nil

	case "add", "subtract", "compare":
		left, err := readAmount(input["left"])
		if err != nil {
			return nil, err
		}
		right, err := readAmount(input["right"])
		if err != nil {
			return nil, err
		}
		switch str(input, "op") {
		case "add":
			sum, err := addAmounts(left, right)
			if err != nil {
				return map[string]any{"error": errorCode(err)}, nil
			}
			return map[string]any{"amount": wireAmount(sum)}, nil
		case "subtract":
			diff, err := subtractAmounts(left, right)
			if err != nil {
				return map[string]any{"error": errorCode(err)}, nil
			}
			return map[string]any{"amount": wireAmount(diff)}, nil
		default:
			ordering, err := compareAmounts(left, right)
			if err != nil {
				return map[string]any{"error": errorCode(err)}, nil
			}
			return map[string]any{"ordering": json.Number(fmt.Sprint(ordering))}, nil
		}
	}
	return nil, fmt.Errorf("unknown amount op %q", str(input, "op"))
}

func runAllocateCase(_ *vectorSuite, c vectorCase, input map[string]any) (map[string]any, error) {
	amount, err := readAmount(input["amount"])
	if err != nil {
		return nil, err
	}
	rawWeights, _ := input["weights"].([]any)
	weights := make([]*big.Int, 0, len(rawWeights))
	for _, raw := range rawWeights {
		text, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("weight is not a string")
		}
		value, ok := newIntFromString(text)
		if !ok {
			return nil, fmt.Errorf("bad weight %q", text)
		}
		weights = append(weights, value)
	}

	parts, err := allocate(amount, weights)
	if err != nil {
		return map[string]any{"error": errorCode(err)}, nil
	}

	wired := make([]any, len(parts))
	sum := new(big.Int)
	for i, part := range parts {
		wired[i] = wireAmount(part)
		sum.Add(sum, part.Minor)
	}
	_ = c
	return map[string]any{"parts": wired, "sum": sum.String()}, nil
}
