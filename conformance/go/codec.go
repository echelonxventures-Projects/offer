// Package main is an independent implementation of the GOIP specification,
// written to prove the spec is portable rather than merely claimed to be.
//
// It shares no code with the TypeScript reference. It reads the same vector
// files from ../../spec/vectors and must reproduce them exactly.
//
// Only the Go standard library is used. `math/big` stands in for TypeScript's
// native bigint, which is itself part of the point: an implementation language
// with no built-in arbitrary-precision integer must still produce identical
// results, and if the spec were vague about integer semantics it would not.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

const (
	bigintPrefix = "~bigint:"
	escapePrefix = "~esc:"
)

// decodeJSON parses a document, restoring tagged big integers.
//
// Numbers are kept as json.Number so an integer written as `2` never becomes
// `2.0` on the way back out.
func decodeJSON(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var raw any
	if err := decoder.Decode(&raw); err != nil {
		return nil, err
	}
	return revive(raw), nil
}

func revive(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, inner := range typed {
			out[key] = revive(inner)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, inner := range typed {
			out[i] = revive(inner)
		}
		return out
	case string:
		if strings.HasPrefix(typed, bigintPrefix) {
			n := new(big.Int)
			if _, ok := n.SetString(typed[len(bigintPrefix):], 10); ok {
				return n
			}
			return typed
		}
		if strings.HasPrefix(typed, escapePrefix) {
			return typed[len(escapePrefix):]
		}
		return typed
	default:
		return value
	}
}

// encodeJSON is the inverse of decodeJSON: the wire form, not the canonical
// hashing form. Key order follows Go's map iteration, so it is only used where
// the caller re-parses the result.
func encodeJSON(value any) (string, error) {
	var builder strings.Builder
	if err := writeWire(&builder, value); err != nil {
		return "", err
	}
	return builder.String(), nil
}

func writeWire(out *strings.Builder, value any) error {
	switch typed := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		fmt.Fprintf(out, "%t", typed)
	case json.Number:
		out.WriteString(typed.String())
	case *big.Int:
		out.WriteString(quote(bigintPrefix + typed.String()))
	case string:
		if strings.HasPrefix(typed, bigintPrefix) || strings.HasPrefix(typed, escapePrefix) {
			out.WriteString(quote(escapePrefix + typed))
		} else {
			out.WriteString(quote(typed))
		}
	case []any:
		out.WriteByte('[')
		for i, inner := range typed {
			if i > 0 {
				out.WriteByte(',')
			}
			if err := writeWire(out, inner); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		out.WriteByte('{')
		first := true
		for _, key := range sortedKeys(typed) {
			if !first {
				out.WriteByte(',')
			}
			first = false
			out.WriteString(quote(key))
			out.WriteByte(':')
			if err := writeWire(out, typed[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return fmt.Errorf("cannot encode %T", value)
	}
	return nil
}

// quote produces a JSON string literal matching JSON.stringify's escaping.
func quote(s string) string {
	encoded, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(encoded)
}
