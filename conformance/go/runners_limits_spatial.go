package main

import (
	"encoding/json"
	"fmt"
	"math/big"
)

/* ----------------------------- limits ----------------------------- */

type limitSpec struct {
	totalIssuance       *int
	totalRedemptions    *int
	perSubject          *int
	periodMax           *int
	periodWindowSeconds *float64
	budgetUnit          string
	budgetDecimal       string
}

func readLimitSpec(raw any) limitSpec {
	spec := limitSpec{}
	asMap, ok := raw.(map[string]any)
	if !ok {
		return spec
	}
	readInt := func(key string) *int {
		if v, ok := asMap[key].(json.Number); ok {
			n, err := v.Int64()
			if err == nil {
				value := int(n)
				return &value
			}
		}
		return nil
	}
	spec.totalIssuance = readInt("totalIssuance")
	spec.totalRedemptions = readInt("totalRedemptions")
	spec.perSubject = readInt("perSubject")

	if period, ok := asMap["perSubjectPerPeriod"].(map[string]any); ok {
		if v, ok := period["max"].(json.Number); ok {
			if n, err := v.Int64(); err == nil {
				value := int(n)
				spec.periodMax = &value
			}
		}
		if v, ok := period["windowSeconds"].(json.Number); ok {
			if f, err := v.Float64(); err == nil {
				spec.periodWindowSeconds = &f
			}
		}
	}
	if budget, ok := asMap["totalBudget"].(map[string]any); ok {
		spec.budgetUnit = str(budget, "unit")
		spec.budgetDecimal = str(budget, "decimal")
	}
	return spec
}

type counterSnapshot struct {
	issued             int
	redemptions        int
	subjectRedemptions int
	subjectRecent      []float64
	grantedByUnit      map[string]Amount
}

// findBreach mirrors the reference's check order exactly. The order is
// normative: the reported breach must be the first one in this sequence, so a
// customer is always told the same reason whichever implementation answers.
func findBreach(s counterSnapshot, limits limitSpec, subjectID *string, atSeconds float64, granted []Amount, mode string) map[string]any {
	breach := func(limit, detail string) map[string]any {
		return map[string]any{"limit": limit, "detail": detail}
	}

	if limits.totalRedemptions != nil && s.redemptions >= *limits.totalRedemptions {
		return breach("limit.total_redemptions", fmt.Sprintf("%d/%d", s.redemptions, *limits.totalRedemptions))
	}

	if limits.perSubject != nil {
		if subjectID == nil {
			return breach("limit.per_subject", "anonymous subject cannot be limited per subject")
		}
		if s.subjectRedemptions >= *limits.perSubject {
			return breach("limit.per_subject", fmt.Sprintf("%d/%d", s.subjectRedemptions, *limits.perSubject))
		}
	}

	if limits.periodMax != nil && limits.periodWindowSeconds != nil && subjectID != nil {
		cutoff := atSeconds - *limits.periodWindowSeconds
		inWindow := 0
		for _, seconds := range s.subjectRecent {
			if seconds > cutoff {
				inWindow++
			}
		}
		if inWindow >= *limits.periodMax {
			return breach("limit.per_subject_per_period",
				fmt.Sprintf("%d/%d in the last %ss", inWindow, *limits.periodMax, trimFloat(*limits.periodWindowSeconds)))
		}
	}

	if limits.budgetUnit != "" {
		already, present := s.grantedByUnit[limits.budgetUnit]
		scale := 0
		if present {
			scale = already.Scale
		} else {
			for _, a := range granted {
				if a.Unit == limits.budgetUnit {
					scale = a.Scale
					break
				}
			}
		}
		cap, err := fromDecimal(limits.budgetUnit, limits.budgetDecimal, scale)
		if err != nil {
			return nil
		}
		consumed := new(big.Int)
		if present {
			consumed.Set(already.Minor)
		}
		if mode == "advisory" {
			if consumed.Cmp(cap.Minor) >= 0 {
				return breach("limit.total_budget",
					fmt.Sprintf("%s/%s minor units of %s", consumed.String(), cap.Minor.String(), limits.budgetUnit))
			}
		} else {
			adding := new(big.Int)
			for _, a := range granted {
				if a.Unit == limits.budgetUnit {
					adding.Add(adding, a.Minor)
				}
			}
			after := new(big.Int).Add(consumed, adding)
			if after.Cmp(cap.Minor) > 0 {
				return breach("limit.total_budget",
					fmt.Sprintf("%s/%s minor units of %s", after.String(), cap.Minor.String(), limits.budgetUnit))
			}
		}
	}

	return nil
}

func trimFloat(f float64) string {
	return formatFloat(f)
}

/* ----------------------------- spatial ----------------------------- */

type spatialNode struct {
	key          string
	parent       string
	kind         string
	jurisdiction string
}

type spatialTable map[string]spatialNode

func (t spatialTable) path(key string) ([]string, error) {
	chain := []string{}
	seen := map[string]bool{}
	cursor := key
	for cursor != "" {
		if seen[cursor] {
			return nil, fmt.Errorf("spatial hierarchy contains a cycle at '%s'", cursor)
		}
		seen[cursor] = true
		node, ok := t[cursor]
		if !ok {
			return nil, fmt.Errorf("no entry '%s' in registry 'spatial-node'", cursor)
		}
		chain = append([]string{cursor}, chain...)
		cursor = node.parent
	}
	return chain, nil
}

func (t spatialTable) jurisdictionOf(key string) (string, error) {
	chain, err := t.path(key)
	if err != nil {
		return "", err
	}
	for i := len(chain) - 1; i >= 0; i-- {
		if node, ok := t[chain[i]]; ok && node.jurisdiction != "" {
			return node.jurisdiction, nil
		}
	}
	return "", nil
}

// evaluateScope: exclude always beats include, and an empty include means
// everywhere. Reporting *which* node decided is part of the contract, because
// it is what a decision trace shows a merchant.
func (t spatialTable) evaluateScope(include, exclude []string, place string) (map[string]any, error) {
	chain, err := t.path(place)
	if err != nil {
		return nil, err
	}
	contains := func(list []string, want string) bool {
		for _, item := range list {
			if item == want {
				return true
			}
		}
		return false
	}

	for _, excluded := range exclude {
		if contains(chain, excluded) {
			return map[string]any{"inside": false, "excludedBy": excluded}, nil
		}
	}
	if len(include) == 0 {
		return map[string]any{"inside": true}, nil
	}
	for _, included := range include {
		if contains(chain, included) {
			return map[string]any{"inside": true, "matchedBy": included}, nil
		}
	}
	return map[string]any{"inside": false}, nil
}

func init() {
	runners["limits"] = func(_ *vectorSuite, _ vectorCase, input map[string]any) (map[string]any, error) {
		rawSnapshot, _ := input["snapshot"].(map[string]any)
		snapshot := counterSnapshot{
			issued:             num(rawSnapshot, "issued"),
			redemptions:        num(rawSnapshot, "redemptions"),
			subjectRedemptions: num(rawSnapshot, "subjectRedemptions"),
			grantedByUnit:      map[string]Amount{},
		}
		if recent, ok := rawSnapshot["subjectRecent"].([]any); ok {
			for _, entry := range recent {
				if n, ok := entry.(json.Number); ok {
					if f, err := n.Float64(); err == nil {
						snapshot.subjectRecent = append(snapshot.subjectRecent, f)
					}
				}
			}
		}
		if grantedMap, ok := rawSnapshot["grantedByUnit"].(map[string]any); ok {
			for unit, raw := range grantedMap {
				amount, err := readAmount(raw)
				if err != nil {
					return nil, err
				}
				snapshot.grantedByUnit[unit] = amount
			}
		}

		var subjectID *string
		if value, ok := input["subjectId"].(string); ok {
			subjectID = &value
		}

		var granted []Amount
		if list, ok := input["granted"].([]any); ok {
			for _, raw := range list {
				amount, err := readAmount(raw)
				if err != nil {
					return nil, err
				}
				granted = append(granted, amount)
			}
		}

		atSeconds := float64(num(input, "atSeconds"))
		breach := findBreach(snapshot, readLimitSpec(input["limits"]), subjectID, atSeconds, granted, str(input, "mode"))
		// A typed nil map would canonicalize as {}, not null; the distinction
		// between "no breach" and "an empty breach" is the whole answer here.
		if breach == nil {
			return map[string]any{"breach": nil}, nil
		}
		return map[string]any{"breach": breach}, nil
	}

	var table spatialTable

	runners["spatial"] = func(_ *vectorSuite, c vectorCase, input map[string]any) (map[string]any, error) {
		if nodes, ok := input["nodes"].([]any); ok {
			table = spatialTable{}
			for _, raw := range nodes {
				node, _ := raw.(map[string]any)
				table[str(node, "key")] = spatialNode{
					key:          str(node, "key"),
					parent:       str(node, "parent"),
					kind:         str(node, "kind"),
					jurisdiction: str(node, "jurisdiction"),
				}
			}
			return nil, nil // setup case
		}
		if table == nil {
			return nil, fmt.Errorf("spatial node table was never supplied")
		}

		if str(input, "op") == "path" {
			key := str(input, "key")
			chain, err := table.path(key)
			if err != nil {
				return nil, err
			}
			jurisdiction, err := table.jurisdictionOf(key)
			if err != nil {
				return nil, err
			}
			asAny := make([]any, len(chain))
			for i, item := range chain {
				asAny[i] = item
			}
			var jurisdictionValue any
			if jurisdiction != "" {
				jurisdictionValue = jurisdiction
			}
			return map[string]any{"path": asAny, "jurisdiction": jurisdictionValue}, nil
		}

		scope, _ := input["scope"].(map[string]any)
		toList := func(key string) []string {
			out := []string{}
			if raw, ok := scope[key].([]any); ok {
				for _, item := range raw {
					if text, ok := item.(string); ok {
						out = append(out, text)
					}
				}
			}
			return out
		}
		verdict, err := table.evaluateScope(toList("include"), toList("exclude"), str(input, "place"))
		if err != nil {
			return nil, err
		}
		_ = c
		return map[string]any{"verdict": verdict}, nil
	}
}
