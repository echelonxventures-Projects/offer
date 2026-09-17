package main

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

/* --------------------------- evaluation state --------------------------- */

const (
	maxDepth = 32
	maxNodes = 5000
)

type ruleError struct {
	code    string
	message string
}

func (e *ruleError) Error() string { return e.code + ": " + e.message }

func ruleFail(format string, args ...any) error {
	return &ruleError{code: "RULE_ERROR", message: fmt.Sprintf(format, args...)}
}

func unknownEntry(registry, key string) error {
	return &ruleError{code: "UNKNOWN_REGISTRY_ENTRY", message: fmt.Sprintf("no entry '%s' in registry '%s'", key, registry)}
}

type traceEntry struct {
	op     string
	result bool
	depth  int
}

type evaluation struct {
	context map[string]any
	trace   []traceEntry
	budget  int
}

func (e *evaluation) spend() error {
	e.budget--
	if e.budget < 0 {
		return ruleFail("rule exceeded the node budget of %d", maxNodes)
	}
	return nil
}

/* ------------------------------- paths -------------------------------- */

// readPath is the one accessor rules use. It never throws: a missing path is
// undefined, which operators handle explicitly.
func readPath(root any, path string) any {
	if path == "" {
		return root
	}
	cursor := root
	for _, segment := range strings.Split(path, ".") {
		if cursor == nil {
			return nil
		}
		switch typed := cursor.(type) {
		case []any:
			index := 0
			if _, err := fmt.Sscanf(segment, "%d", &index); err != nil || index < 0 || index >= len(typed) {
				return nil
			}
			cursor = typed[index]
		case map[string]any:
			value, ok := typed[segment]
			if !ok {
				return nil
			}
			cursor = value
		default:
			return nil
		}
	}
	return cursor
}

/* ------------------------------- terms -------------------------------- */

func (e *evaluation) resolveTerm(term any, depth int) (any, error) {
	if err := e.spend(); err != nil {
		return nil, err
	}
	asMap, ok := term.(map[string]any)
	if !ok {
		return term, nil // bare JSON is a literal
	}

	if value, present := asMap["literal"]; present {
		return value, nil
	}
	if raw, present := asMap["path"]; present {
		path, _ := raw.(string)
		value := readPath(e.context, path)
		if value == nil {
			if fallback, hasDefault := asMap["default"]; hasDefault {
				return fallback, nil
			}
		}
		return value, nil
	}
	if raw, present := asMap["amount"]; present {
		spec, _ := raw.(map[string]any)
		unit := str(spec, "unit")
		scale, ok := unitScales[unit]
		if !ok {
			return nil, unknownEntry("economic-unit", unit)
		}
		amount, err := fromDecimal(unit, str(spec, "decimal"), scale)
		if err != nil {
			return nil, err
		}
		return amount, nil
	}
	if raw, present := asMap["fn"]; present {
		name, _ := raw.(string)
		fn, known := ruleFunctions[name]
		if !known {
			return nil, unknownEntry("rule-function", name)
		}
		rawArgs, _ := asMap["args"].([]any)
		if fn.arity >= 0 && len(rawArgs) != fn.arity {
			return nil, ruleFail("function '%s' expects %d argument(s), got %d", name, fn.arity, len(rawArgs))
		}
		values := make([]any, 0, len(rawArgs))
		for _, arg := range rawArgs {
			value, err := e.resolveTerm(arg, depth+1)
			if err != nil {
				return nil, err
			}
			values = append(values, value)
		}
		return fn.call(values, e)
	}
	return term, nil
}

/* ---------------------------- comparison ------------------------------ */

func asAmount(value any) (Amount, bool) {
	amount, ok := value.(Amount)
	return amount, ok
}

func asBig(value any) (*big.Int, bool) {
	switch typed := value.(type) {
	case *big.Int:
		return typed, true
	case json.Number:
		if i, err := typed.Int64(); err == nil {
			return big.NewInt(i), true
		}
	}
	return nil, false
}

func compareValues(left, right any) (int, error) {
	if l, ok := asAmount(left); ok {
		if r, ok := asAmount(right); ok {
			return compareAmounts(l, r)
		}
		return 0, ruleFail("cannot order %s against %s", describe(left), describe(right))
	}
	if l, ok := asBig(left); ok {
		if r, ok := asBig(right); ok {
			return l.Cmp(r), nil
		}
	}
	ls, lok := left.(string)
	rs, rok := right.(string)
	if lok && rok {
		return strings.Compare(ls, rs), nil
	}
	lb, lok := left.(bool)
	rb, rok := right.(bool)
	if lok && rok {
		switch {
		case lb == rb:
			return 0, nil
		case lb:
			return 1, nil
		default:
			return -1, nil
		}
	}
	return 0, ruleFail("cannot order %s against %s", describe(left), describe(right))
}

func equalValues(left, right any) bool {
	if l, ok := asAmount(left); ok {
		r, ok := asAmount(right)
		return ok && l.Unit == r.Unit && l.Scale == r.Scale && l.Minor.Cmp(r.Minor) == 0
	}
	if l, ok := asBig(left); ok {
		if r, ok := asBig(right); ok {
			return l.Cmp(r) == 0
		}
		return false
	}
	switch l := left.(type) {
	case nil:
		return right == nil
	case string:
		r, ok := right.(string)
		return ok && l == r
	case bool:
		r, ok := right.(bool)
		return ok && l == r
	case []any:
		r, ok := right.([]any)
		if !ok || len(l) != len(r) {
			return false
		}
		for i := range l {
			if !equalValues(l[i], r[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		r, ok := right.(map[string]any)
		if !ok || len(l) != len(r) {
			return false
		}
		for key, value := range l {
			other, present := r[key]
			if !present || !equalValues(value, other) {
				return false
			}
		}
		return true
	}
	return false
}

func describe(value any) string {
	switch typed := value.(type) {
	case nil:
		return "undefined"
	case Amount:
		return "amount(" + typed.Unit + ")"
	case []any:
		return fmt.Sprintf("array[%d]", len(typed))
	case string:
		return "string"
	case bool:
		return "boolean"
	case *big.Int, json.Number:
		return "number"
	}
	return "object"
}

// globMatch: two pointers, one backtrack point. Linear in the input, and no
// pattern can make it blow up - which is exactly why there is no regex operator.
func globMatch(pattern, value string) bool {
	p, v, star, mark := 0, 0, -1, 0
	for v < len(value) {
		if p < len(pattern) && (pattern[p] == '?' || pattern[p] == value[v]) {
			p++
			v++
		} else if p < len(pattern) && pattern[p] == '*' {
			star, mark = p, v
			p++
		} else if star != -1 {
			p = star + 1
			mark++
			v = mark
		} else {
			return false
		}
	}
	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}

/* ------------------------------ operators ------------------------------ */

func (e *evaluation) evaluate(node any, depth int) (bool, error) {
	if depth > maxDepth {
		return false, ruleFail("rule nested deeper than %d", maxDepth)
	}
	asMap, ok := node.(map[string]any)
	if !ok {
		return false, ruleFail("rule node must be an object with an 'op' property")
	}
	op, ok := asMap["op"].(string)
	if !ok {
		return false, ruleFail("rule node must be an object with an 'op' property")
	}
	if err := e.spend(); err != nil {
		return false, err
	}

	result, err := e.apply(op, asMap, depth)
	if err != nil {
		return false, err
	}
	e.trace = append(e.trace, traceEntry{op: op, result: result, depth: depth})
	return result, nil
}

func (e *evaluation) children(node map[string]any) ([]any, error) {
	list, ok := node["of"].([]any)
	if !ok {
		return nil, ruleFail("'%s' needs an array in 'of'", node["op"])
	}
	return list, nil
}

func (e *evaluation) apply(op string, node map[string]any, depth int) (bool, error) {
	switch op {
	case "always":
		return true, nil
	case "never":
		return false, nil

	case "all":
		children, err := e.children(node)
		if err != nil {
			return false, err
		}
		for _, child := range children {
			outcome, err := e.evaluate(child, depth+1)
			if err != nil {
				return false, err
			}
			if !outcome {
				return false, nil // short-circuit: the rest must not be evaluated
			}
		}
		return true, nil

	case "any":
		children, err := e.children(node)
		if err != nil {
			return false, err
		}
		for _, child := range children {
			outcome, err := e.evaluate(child, depth+1)
			if err != nil {
				return false, err
			}
			if outcome {
				return true, nil
			}
		}
		return false, nil

	case "none":
		children, err := e.children(node)
		if err != nil {
			return false, err
		}
		for _, child := range children {
			outcome, err := e.evaluate(child, depth+1)
			if err != nil {
				return false, err
			}
			if outcome {
				return false, nil
			}
		}
		return true, nil

	case "not":
		outcome, err := e.evaluate(node["of"], depth+1)
		if err != nil {
			return false, err
		}
		return !outcome, nil

	case "eq", "ne":
		left, err := e.resolveTerm(node["left"], depth)
		if err != nil {
			return false, err
		}
		right, err := e.resolveTerm(node["right"], depth)
		if err != nil {
			return false, err
		}
		same := equalValues(left, right)
		if op == "eq" {
			return same, nil
		}
		return !same, nil

	case "gt", "gte", "lt", "lte":
		left, err := e.resolveTerm(node["left"], depth)
		if err != nil {
			return false, err
		}
		right, err := e.resolveTerm(node["right"], depth)
		if err != nil {
			return false, err
		}
		ordering, err := compareValues(left, right)
		if err != nil {
			return false, err
		}
		switch op {
		case "gt":
			return ordering > 0, nil
		case "gte":
			return ordering >= 0, nil
		case "lt":
			return ordering < 0, nil
		default:
			return ordering <= 0, nil
		}

	case "between":
		value, err := e.resolveTerm(node["value"], depth)
		if err != nil {
			return false, err
		}
		low, err := e.resolveTerm(node["low"], depth)
		if err != nil {
			return false, err
		}
		high, err := e.resolveTerm(node["high"], depth)
		if err != nil {
			return false, err
		}
		lowCmp, err := compareValues(value, low)
		if err != nil {
			return false, err
		}
		highCmp, err := compareValues(value, high)
		if err != nil {
			return false, err
		}
		return lowCmp >= 0 && highCmp <= 0, nil

	case "exists":
		value, err := e.resolveTerm(node["value"], depth)
		if err != nil {
			return false, err
		}
		return value != nil, nil

	case "in", "notIn":
		value, err := e.resolveTerm(node["value"], depth)
		if err != nil {
			return false, err
		}
		options, err := e.resolveTerm(node["options"], depth)
		if err != nil {
			return false, err
		}
		list, ok := options.([]any)
		if !ok {
			return false, ruleFail("'%s' needs an array in 'options'", op)
		}
		found := false
		for _, candidate := range list {
			if equalValues(value, candidate) {
				found = true
				break
			}
		}
		if op == "in" {
			return found, nil
		}
		return !found, nil

	case "includesAny", "includesAll":
		collection, err := e.resolveTerm(node["collection"], depth)
		if err != nil {
			return false, err
		}
		values, err := e.resolveTerm(node["values"], depth)
		if err != nil {
			return false, err
		}
		items, ok := collection.([]any)
		if !ok {
			return false, ruleFail("'%s' needs an array in 'collection'", op)
		}
		wanted, ok := values.([]any)
		if !ok {
			wanted = []any{values}
		}
		hit := func(candidate any) bool {
			for _, item := range items {
				if equalValues(item, candidate) {
					return true
				}
			}
			return false
		}
		if op == "includesAny" {
			for _, candidate := range wanted {
				if hit(candidate) {
					return true, nil
				}
			}
			return false, nil
		}
		for _, candidate := range wanted {
			if !hit(candidate) {
				return false, nil
			}
		}
		return true, nil

	case "sizeOf":
		collection, err := e.resolveTerm(node["collection"], depth)
		if err != nil {
			return false, err
		}
		items, ok := collection.([]any)
		if !ok {
			return false, ruleFail("'sizeOf' needs an array in 'collection'")
		}
		size := big.NewInt(int64(len(items)))
		if raw, present := node["gte"]; present {
			bound, err := e.resolveTerm(raw, depth)
			if err != nil {
				return false, err
			}
			if b, ok := asBig(bound); ok && size.Cmp(b) < 0 {
				return false, nil
			}
		}
		if raw, present := node["lte"]; present {
			bound, err := e.resolveTerm(raw, depth)
			if err != nil {
				return false, err
			}
			if b, ok := asBig(bound); ok && size.Cmp(b) > 0 {
				return false, nil
			}
		}
		return true, nil

	case "glob":
		value, err := e.resolveTerm(node["value"], depth)
		if err != nil {
			return false, err
		}
		pattern, err := e.resolveTerm(node["pattern"], depth)
		if err != nil {
			return false, err
		}
		valueText, ok1 := value.(string)
		patternText, ok2 := pattern.(string)
		if !ok1 || !ok2 {
			return false, ruleFail("'glob' needs strings in 'value' and 'pattern'")
		}
		return globMatch(patternText, valueText), nil

	case "temporal.field":
		field, _ := node["field"].(string)
		if field == "" {
			return false, ruleFail("'temporal.field' needs a 'field' name")
		}
		fields, _ := readPath(e.context, "temporal.fields").(map[string]any)
		raw, present := fields[field]
		if !present {
			return false, nil // a field this calendar does not publish is false
		}
		value := numberOf(raw)
		if allowed, ok := node["in"].([]any); ok {
			found := false
			for _, entry := range allowed {
				if numberOf(entry) == value {
					found = true
					break
				}
			}
			if !found {
				return false, nil
			}
		}
		if raw, ok := node["min"]; ok && value < numberOf(raw) {
			return false, nil
		}
		if raw, ok := node["max"]; ok && value > numberOf(raw) {
			return false, nil
		}
		return true, nil

	case "subject.hasSegment", "subject.hasMembership":
		key := "segments"
		listKey := "subject.segments"
		if op == "subject.hasMembership" {
			key = "memberships"
			listKey = "subject.memberships"
		}
		wanted, _ := node[key].([]any)
		held, _ := readPath(e.context, listKey).([]any)
		contains := func(want any) bool {
			for _, item := range held {
				if equalValues(item, want) {
					return true
				}
			}
			return false
		}
		if op == "subject.hasMembership" || str(node, "mode") != "all" {
			for _, want := range wanted {
				if contains(want) {
					return true, nil
				}
			}
			return false, nil
		}
		for _, want := range wanted {
			if !contains(want) {
				return false, nil
			}
		}
		return true, nil

	case "spatial.within":
		place, _ := readPath(e.context, "spatial.place").(string)
		if place == "" {
			return false, nil
		}
		path, _ := readPath(e.context, "spatial.path").([]any)
		inPath := func(want string) bool {
			for _, item := range path {
				if text, ok := item.(string); ok && text == want {
					return true
				}
			}
			return false
		}
		exclude, _ := node["exclude"].([]any)
		for _, raw := range exclude {
			if text, ok := raw.(string); ok && inPath(text) {
				return false, nil
			}
		}
		include, _ := node["nodes"].([]any)
		if len(include) == 0 {
			return true, nil
		}
		for _, raw := range include {
			if text, ok := raw.(string); ok && inPath(text) {
				return true, nil
			}
		}
		return false, nil

	case "spatial.jurisdiction":
		jurisdiction, _ := readPath(e.context, "spatial.jurisdiction").(string)
		if jurisdiction == "" {
			return false, nil
		}
		allowed, _ := node["in"].([]any)
		for _, raw := range allowed {
			if text, ok := raw.(string); ok && text == jurisdiction {
				return true, nil
			}
		}
		return false, nil
	}

	return false, unknownEntry("rule-operator", op)
}

/* ------------------------------ functions ------------------------------ */

type ruleFunction struct {
	arity int
	call  func(args []any, e *evaluation) (any, error)
}

var unitScales = map[string]int{"USD": 2, "EUR": 2, "INR": 2, "JPY": 0, "POINTS": 0, "MARS_CREDIT": 4}

func toStringList(value any) []string {
	out := []string{}
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if text, ok := item.(string); ok {
				out = append(out, text)
			}
		}
	case string:
		out = append(out, typed)
	}
	return out
}

func contextLines(e *evaluation) []cartLine {
	raw := readPath(e.context, "cart.lines")
	lines, err := readLines(raw)
	if err != nil {
		return nil
	}
	return lines
}

func linesIn(lines []cartLine, categories []string) []cartLine {
	if len(categories) == 0 {
		return lines
	}
	out := []cartLine{}
	for _, line := range lines {
		for _, category := range line.categories {
			matched := false
			for _, want := range categories {
				if category == want {
					matched = true
					break
				}
			}
			if matched {
				out = append(out, line)
				break
			}
		}
	}
	return out
}

var ruleFunctions = map[string]ruleFunction{
	"list": {arity: -1, call: func(args []any, _ *evaluation) (any, error) { return args, nil }},

	"cart.quantityIn": {arity: 1, call: func(args []any, e *evaluation) (any, error) {
		total := int64(0)
		for _, line := range linesIn(contextLines(e), toStringList(args[0])) {
			total += line.quantity
		}
		return json.Number(fmt.Sprint(total)), nil
	}},

	"cart.subtotalOf": {arity: 1, call: func(args []any, e *evaluation) (any, error) {
		economic, _ := readPath(e.context, "economic").(map[string]any)
		unit := str(economic, "unit")
		scale := num(economic, "scale")
		total := Amount{Unit: unit, Scale: scale, Minor: big.NewInt(0)}
		for _, line := range linesIn(contextLines(e), toStringList(args[0])) {
			next, err := addAmounts(total, line.total())
			if err != nil {
				return nil, err
			}
			total = next
		}
		return total, nil
	}},

	"cart.hasSku": {arity: 1, call: func(args []any, e *evaluation) (any, error) {
		patterns := toStringList(args[0])
		for _, line := range contextLines(e) {
			for _, pattern := range patterns {
				if globMatch(pattern, line.sku) {
					return true, nil
				}
			}
		}
		return false, nil
	}},

	"cart.merchants": {arity: 0, call: func(_ []any, e *evaluation) (any, error) {
		seen := map[string]bool{}
		names := []string{}
		for _, line := range contextLines(e) {
			if line.merchant != "" && !seen[line.merchant] {
				seen[line.merchant] = true
				names = append(names, line.merchant)
			}
		}
		sortStrings(names)
		out := make([]any, len(names))
		for i, name := range names {
			out[i] = name
		}
		return out, nil
	}},

	"subject.counter": {arity: 1, call: func(args []any, e *evaluation) (any, error) {
		name, ok := args[0].(string)
		if !ok {
			return nil, ruleFail("'subject.counter' needs a counter name")
		}
		counters, _ := readPath(e.context, "subject.counters").(map[string]any)
		if value, present := counters[name]; present {
			return value, nil
		}
		return json.Number("0"), nil
	}},

	"facet": {arity: 2, call: func(args []any, e *evaluation) (any, error) {
		key, ok := args[0].(string)
		if !ok {
			return nil, ruleFail("'facet' needs a facet key")
		}
		facets, _ := readPath(e.context, "facets").(map[string]any)
		if value, present := facets[key]; present {
			return value, nil
		}
		return args[1], nil
	}},
}

func sortStrings(items []string) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j] < items[j-1]; j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}

/* ------------------------------- runner -------------------------------- */

// hydrate converts the normative wire shapes into native values before
// evaluation: amounts become Amount, everything else is left alone.
func hydrate(value any) any {
	switch typed := value.(type) {
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = hydrate(item)
		}
		return out
	case map[string]any:
		if len(typed) == 3 {
			_, hasUnit := typed["unit"]
			_, hasMinor := typed["minor"]
			_, hasScale := typed["scale"]
			if hasUnit && hasMinor && hasScale {
				if amount, err := readAmount(typed); err == nil {
					return amount
				}
			}
		}
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = hydrate(item)
		}
		return out
	}
	return value
}

func init() {
	var ruleContext map[string]any

	runners["rules"] = func(_ *vectorSuite, _ vectorCase, input map[string]any) (map[string]any, error) {
		if raw, present := input["context"]; present {
			hydrated, _ := hydrate(raw).(map[string]any)
			ruleContext = hydrated
			return nil, nil // setup case
		}
		if ruleContext == nil {
			return nil, fmt.Errorf("rule context was never supplied")
		}

		e := &evaluation{context: ruleContext, budget: maxNodes}
		satisfied, err := e.evaluate(input["rule"], 0)
		if err != nil {
			var typed *ruleError
			if errors, ok := err.(*ruleError); ok {
				typed = errors
			}
			if typed != nil {
				return map[string]any{"error": typed.code}, nil
			}
			return map[string]any{"error": "RULE_ERROR"}, nil
		}

		trace := make([]any, len(e.trace))
		for i, entry := range e.trace {
			trace[i] = map[string]any{
				"op":     entry.op,
				"result": entry.result,
				"depth":  json.Number(fmt.Sprint(entry.depth)),
			}
		}
		return map[string]any{"satisfied": satisfied, "trace": trace}, nil
	}
}
