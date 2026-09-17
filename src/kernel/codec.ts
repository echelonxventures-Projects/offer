/**
 * Wire codec.
 *
 * JSON has no integer type large enough for exact money, so amounts are
 * `bigint` in memory and must survive a round trip through storage and over a
 * network. This is the one place that decides how.
 *
 * The representation is the same one `canonicalize` uses for hashing:
 *
 *     1234n   <->   "~bigint:1234"
 *
 * A tagged string rather than a JSON number, because a number would be silently
 * rounded by any parser that reads it as a double - which is every parser, in
 * every language, by default. A tagged string is unambiguous and survives
 * intact through systems that know nothing about this convention.
 *
 * The prefix is deliberately unlikely: a plain string that happens to start
 * with `~bigint:` is escaped on the way out and unescaped on the way in, so the
 * round trip is lossless for every input.
 */

const BIGINT_PREFIX = "~bigint:";
const ESCAPE_PREFIX = "~esc:";

/** Serialise, preserving bigints exactly. Key order follows insertion. */
export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, raw) => replace(raw));
}

/** Parse, restoring bigints. Inverse of `encode`. */
export function decode<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, raw) => revive(raw)) as T;
}

function replace(raw: unknown): unknown {
  if (typeof raw === "bigint") return `${BIGINT_PREFIX}${raw.toString()}`;
  if (typeof raw === "string" && (raw.startsWith(BIGINT_PREFIX) || raw.startsWith(ESCAPE_PREFIX))) {
    return `${ESCAPE_PREFIX}${raw}`;
  }
  return raw;
}

function revive(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (raw.startsWith(BIGINT_PREFIX)) return BigInt(raw.slice(BIGINT_PREFIX.length));
  if (raw.startsWith(ESCAPE_PREFIX)) return raw.slice(ESCAPE_PREFIX.length);
  return raw;
}

/**
 * The JSON.stringify replacer, exported for callers that want to serialise with
 * their own options (pretty-printing a decision for a log, say).
 */
export const bigintReplacer = (_key: string, raw: unknown): unknown => replace(raw);
export const bigintReviver = (_key: string, raw: unknown): unknown => revive(raw);
