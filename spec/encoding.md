# Encoding

Two encodings, for two different jobs. Confusing them forks the audit chain.

| Form | Used for | Key order | Function |
| --- | --- | --- | --- |
| **Canonical** | Hashing | Sorted | `canonicalize` |
| **Wire** | Storage and transport | Insertion | `encode` / `decode` |

---

## Exact integers

JSON has no integer type large enough for exact money, and every JSON parser
reads a bare number as a double by default. So exact integers are **tagged
strings**:

```
1234n   <->   "~bigint:1234"
```

A literal string that would collide with the tag is escaped:

```
"~bigint:9"   <->   "~esc:~bigint:9"
```

The round trip is lossless for every input, which is what makes it safe to apply
blindly to a whole document.

Amounts in vectors use a related but distinct convention — `minor` as a plain
decimal string inside a three-key object — because an amount is a value the
specification talks *about*, not an opaque payload. See `conformance.md`.

## Canonical form

Used only for hashing. Rules:

| Input | Output |
| --- | --- |
| `null` | `null` |
| absent key | omitted |
| explicit `undefined` | omitted — identical to absent |
| `true` / `false` | `true` / `false` |
| exact integer | `"~bigint:N"` |
| number | ECMAScript `Number → String` |
| string | JSON string literal |
| array | `[a,b,c]`, order preserved |
| object | `{...}` with keys **sorted by code unit** |

Two rules do the real work:

**Keys sort.** Insertion order is not semantic, so it must not affect the hash.
`{a:1,b:2}` and `{b:2,a:1}` produce identical bytes.

**Absent and undefined are the same.** An implementation that distinguishes
them would hash differently for a record that means the same thing.

### The number trap

Numbers are formatted as ECMAScript formats them. The input `2.0` hashes as
`2`, not `2.0`. An implementation that emits its own language's default float
formatting will hash differently and silently fork the chain — and nothing will
notice until a verification fails months later.

The Go reference implements this explicitly rather than using `%v`:

```go
if f == math.Trunc(f) && math.Abs(f) < 1e21 {
    return strconv.FormatFloat(f, 'f', -1, 64)
}
```

Non-finite numbers are **out of scope**: JSON cannot carry them, so they cannot
reach an implementation over any wire.

## The audit chain

```
hash = sha256(previousHash + "|" + canonical(record-without-hash))
genesis = "0" × 64
```

The record body being hashed is the draft plus its assigned `seq` and
`previousHash`. The separator is `|`; the previous hash is always exactly 64 hex
characters, so the split point is unambiguous regardless.

Chains are **per tenant**, each starting from genesis. This is not only
isolation: a global chain would serialise every append across the platform.

Verified by `vectors/audit-chain.json`, which pins three records to exact
hashes. If your implementation reproduces those, its encoding is compatible with
every other implementation's.
