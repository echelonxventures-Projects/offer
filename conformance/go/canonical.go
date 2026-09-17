package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
)

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// canonicalize is the hashing form: keys sorted, integers tagged, nothing
// ambiguous. Two structurally equal values must produce identical bytes here,
// in every implementation, or the audit chain forks.
func canonicalize(value any) string {
	var builder strings.Builder
	writeCanonical(&builder, value)
	return builder.String()
}

func writeCanonical(out *strings.Builder, value any) {
	switch typed := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		if typed {
			out.WriteString("true")
		} else {
			out.WriteString("false")
		}
	case *big.Int:
		out.WriteString(quote(bigintPrefix + typed.String()))
	case json.Number:
		out.WriteString(formatNumber(typed))
	case float64:
		out.WriteString(formatFloat(typed))
	case int:
		out.WriteString(strconv.Itoa(typed))
	case string:
		out.WriteString(quote(typed))
	case []any:
		out.WriteByte('[')
		for i, inner := range typed {
			if i > 0 {
				out.WriteByte(',')
			}
			writeCanonical(out, inner)
		}
		out.WriteByte(']')
	case map[string]any:
		out.WriteByte('{')
		first := true
		for _, key := range sortedKeys(typed) {
			if typed[key] == nil {
				// null is encoded; only *absent* keys are skipped, and a Go map
				// cannot distinguish absent from nil, so nil is written.
				_ = key
			}
			if !first {
				out.WriteByte(',')
			}
			first = false
			out.WriteString(quote(key))
			out.WriteByte(':')
			writeCanonical(out, typed[key])
		}
		out.WriteByte('}')
	default:
		out.WriteString(quote(fmt.Sprintf("%v", typed)))
	}
}

// formatNumber renders a JSON number the way ECMAScript's Number->String does,
// because that is what the reference implementation's canonical form uses. The
// difference matters: JS prints 2 for the input `2.0`, and an implementation
// that printed "2.0" would hash differently and silently fork the chain.
func formatNumber(n json.Number) string {
	if asInt, err := n.Int64(); err == nil {
		return strconv.FormatInt(asInt, 10)
	}
	asFloat, err := n.Float64()
	if err != nil {
		return n.String()
	}
	return formatFloat(asFloat)
}

func formatFloat(f float64) string {
	if math.IsInf(f, 1) {
		return quote("~number:Infinity")
	}
	if math.IsInf(f, -1) {
		return quote("~number:-Infinity")
	}
	if math.IsNaN(f) {
		return quote("~number:NaN")
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

func sha256Hex(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

const genesisHash = "0000000000000000000000000000000000000000000000000000000000000000"

// chainHash links an audit record to its predecessor. The separator is '|'; the
// previous hash is always 64 hex characters, so the split point is unambiguous.
func chainHash(previousHash string, record any) string {
	return sha256Hex(previousHash + "|" + canonicalize(record))
}
