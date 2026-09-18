/**
 * Deterministic ordering.
 *
 * `String.prototype.localeCompare` is the obvious way to sort strings and the
 * wrong one here. It collates using the host's ICU data and default locale, so
 * the same records can come back in different orders on different machines,
 * under a different `LANG`, or in a runtime built without full ICU.
 *
 * That matters more than usual in this platform for two reasons:
 *
 *  - **Adapters must agree.** SQLite's `ORDER BY` uses BINARY collation, which
 *    is codepoint order. A JavaScript adapter sorting the same ids with
 *    `localeCompare` returns a different order for anything mixed-case - and
 *    account ids embed unit codes like `USD`, while source and subject ids are
 *    tenant-supplied.
 *  - **Other implementations must agree.** Go's `sort.Strings` is codepoint
 *    order. A specification that says "sorted" and means "sorted according to
 *    whatever locale the process happens to have" is not a specification.
 *
 * So: one comparator, codepoint order, used everywhere ordering is observable.
 * It is the same order `canonical.ts` already uses for object keys, which is
 * what makes hashes agree across implementations.
 */

/** Codepoint order. Deterministic on every host, in every locale. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `compareKeys` over several fields in turn; the first difference wins. */
export function compareBy(...fields: readonly string[]): number {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const order = compareKeys(fields[i] as string, fields[i + 1] as string);
    if (order !== 0) return order;
  }
  return 0;
}
