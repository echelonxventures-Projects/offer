/**
 * Canonical JSON encoding.
 *
 * Audit records are hash-chained, so two runs that produce the same decision
 * must produce byte-identical bytes. `JSON.stringify` does not guarantee that
 * (key order follows insertion order), so we sort keys and give bigint,
 * undefined and non-finite numbers an explicit, stable spelling.
 */

export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return '"~undefined"';

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return `"~bigint:${value.toString()}"`;
    case "number":
      return Number.isFinite(value) ? String(value) : `"~number:${String(value)}"`;
    case "string":
      return JSON.stringify(value);
    case "function":
    case "symbol":
      return '"~opaque"';
  }

  if (Array.isArray(value)) {
    return `[${value.map(encode).join(",")}]`;
  }

  if (value instanceof Map) {
    return encode(Object.fromEntries(value));
  }

  if (value instanceof Set) {
    return encode([...value].map(encode).sort());
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    if (obj[key] === undefined) continue; // absent and explicit-undefined hash alike
    parts.push(`${JSON.stringify(key)}:${encode(obj[key])}`);
  }
  return `{${parts.join(",")}}`;
}
