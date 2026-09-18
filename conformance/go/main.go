package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type vectorCase struct {
	ID     string          `json:"id"`
	Note   string          `json:"note"`
	Input  json.RawMessage `json:"input"`
	Expect json.RawMessage `json:"expect"`
}

type vectorSuite struct {
	Suite       string       `json:"suite"`
	Level       string       `json:"level"`
	Description string       `json:"description"`
	Cases       []vectorCase `json:"cases"`
}

// runner produces the actual result for one case. Returning a nil map means
// "this case carries suite setup rather than an assertion".
type runner func(suite *vectorSuite, c vectorCase, input map[string]any) (map[string]any, error)

var runners = map[string]runner{}

func main() {
	root := "../../spec/vectors"
	if len(os.Args) > 1 {
		root = os.Args[1]
	}

	files, err := filepath.Glob(filepath.Join(root, "*.json"))
	if err != nil || len(files) == 0 {
		fmt.Fprintf(os.Stderr, "no vector files under %s\n", root)
		os.Exit(1)
	}
	sort.Strings(files)

	fmt.Println("GOIP conformance - independent Go implementation")
	fmt.Printf("vectors: %s\n\n", root)

	totalPassed, totalFailed, totalSkipped, totalSetup := 0, 0, 0, 0
	var failures []string

	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			fmt.Fprintf(os.Stderr, "cannot read %s: %v\n", file, err)
			os.Exit(1)
		}
		var suite vectorSuite
		if err := json.Unmarshal(data, &suite); err != nil {
			fmt.Fprintf(os.Stderr, "cannot parse %s: %v\n", file, err)
			os.Exit(1)
		}

		run, implemented := runners[suite.Suite]
		if !implemented {
			fmt.Printf("  %-4s %-14s %4d cases   SKIPPED (not implemented)\n", suite.Level, suite.Suite, len(suite.Cases))
			totalSkipped += len(suite.Cases)
			continue
		}

		passed, failed, setup := 0, 0, 0
		for _, c := range suite.Cases {
			input, err := decodeToMap(c.Input)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s/%s: bad input: %v", suite.Suite, c.ID, err))
				failed++
				continue
			}

			actual, err := run(&suite, c, input)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s/%s: %v", suite.Suite, c.ID, err))
				failed++
				continue
			}
			if actual == nil {
				// A setup case seeds a fixture (a spatial tree, a shared context)
				// and asserts nothing. Counted separately so the total reconciles
				// with the vector file's case count instead of quietly shrinking.
				setup++
				continue
			}

			expected, err := decodeToMap(c.Expect)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s/%s: bad expectation: %v", suite.Suite, c.ID, err))
				failed++
				continue
			}

			gotCanonical := canonicalize(actual)
			wantCanonical := canonicalize(expected)
			if gotCanonical != wantCanonical {
				failures = append(failures, fmt.Sprintf(
					"%s/%s\n      want %s\n      got  %s", suite.Suite, c.ID, wantCanonical, gotCanonical))
				failed++
				continue
			}
			passed++
		}

		status := "ok"
		if failed > 0 {
			status = fmt.Sprintf("%d FAILED", failed)
		}
		fmt.Printf("  %-4s %-14s %4d cases   %s\n", suite.Level, suite.Suite, passed+failed, status)
		totalPassed += passed
		totalFailed += failed
		totalSetup += setup
	}

	fmt.Println()
	if len(failures) > 0 {
		fmt.Println("failures:")
		for i, f := range failures {
			if i >= 20 {
				fmt.Printf("  ... and %d more\n", len(failures)-20)
				break
			}
			fmt.Printf("  - %s\n", f)
		}
		fmt.Println()
	}

	fmt.Printf("passed %d, failed %d, skipped %d, setup %d\n", totalPassed, totalFailed, totalSkipped, totalSetup)
	if totalFailed > 0 {
		os.Exit(1)
	}
	if totalSkipped > 0 {
		fmt.Println("\nNOTE: skipped suites are declared, not hidden. This implementation")
		fmt.Println("does not claim the conformance levels they belong to.")
	}
}

func decodeToMap(raw json.RawMessage) (map[string]any, error) {
	value, err := decodeJSON(raw)
	if err != nil {
		return nil, err
	}
	if value == nil {
		return map[string]any{}, nil
	}
	asMap, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("expected an object, got %T", value)
	}
	return asMap, nil
}

/* ------------------------- helpers for runners ------------------------- */

func str(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func num(m map[string]any, key string) int {
	switch v := m[key].(type) {
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return 0
		}
		return int(n)
	}
	return 0
}

func has(m map[string]any, key string) bool {
	_, ok := m[key]
	return ok
}

// wireAmount renders an Amount in the spec's normative wire shape.
func wireAmount(a Amount) map[string]any {
	return map[string]any{"unit": a.Unit, "minor": a.Minor.String(), "scale": a.Scale}
}

// readAmount hydrates the normative wire shape into an Amount. An already
// hydrated Amount passes through, so callers need not track whether a value
// came straight from a vector or from a context that was hydrated once.
func readAmount(value any) (Amount, error) {
	if amount, ok := value.(Amount); ok {
		return amount, nil
	}
	asMap, ok := value.(map[string]any)
	if !ok {
		return Amount{}, fmt.Errorf("not an amount: %T", value)
	}
	minorText := str(asMap, "minor")
	minor, ok := newIntFromString(minorText)
	if !ok {
		return Amount{}, fmt.Errorf("bad minor %q", minorText)
	}
	return Amount{Unit: str(asMap, "unit"), Minor: minor, Scale: num(asMap, "scale")}, nil
}

func errorCode(err error) string {
	text := err.Error()
	if idx := strings.Index(text, ":"); idx > 0 {
		return text[:idx]
	}
	return text
}
