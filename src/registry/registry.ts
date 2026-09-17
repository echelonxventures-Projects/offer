/**
 * The registry: GOIP's one and only extension mechanism.
 *
 * Constitutional rule: anything that varies between industries, organisations,
 * jurisdictions, planets or eras is a registry entry, never a branch in code.
 * A new benefit type, currency, calendar, funding model or attribution model is
 * a `register()` call. If adding one requires editing a `switch`, the design is
 * wrong and the review should reject it.
 *
 * Every registry is enumerable, which is what lets the platform document,
 * govern, diff and version its own extension surface at runtime.
 */
import type { JsonObject } from "../kernel/types.ts";
import type { Result } from "../kernel/result.ts";
import { fail, ok } from "../kernel/result.ts";
import { ErrorCode, invariant } from "../kernel/errors.ts";

/** Every registry entry carries the same descriptive envelope. */
export interface RegistryEntry {
  /** Stable, lowercase, dot/underscore separated. Never renamed once published. */
  readonly key: string;
  /** Human label for consoles and documentation. */
  readonly label: string;
  /** What this entry means and when to choose it. */
  readonly description?: string;
  /** Entry schema version, so handlers can migrate their own payloads. */
  readonly version?: number;
  /** Superseded entries stay resolvable forever; they just warn. */
  readonly deprecated?: boolean;
  /** Free-form, tenant- or domain-specific annotations. */
  readonly metadata?: JsonObject;
}

export interface RegistryOptions {
  /** Reject `register()` for an existing key. Default true. */
  readonly strict?: boolean;
}

export class Registry<T extends RegistryEntry> {
  readonly name: string;
  readonly #entries = new Map<string, T>();
  readonly #strict: boolean;
  #sealed = false;

  constructor(name: string, options: RegistryOptions = {}) {
    this.name = name;
    this.#strict = options.strict ?? true;
  }

  /** Add a new entry. Throws on a duplicate key in strict mode. */
  register(entry: T): this {
    invariant(!this.#sealed, `registry '${this.name}' is sealed; cannot register '${entry.key}'`);
    invariant(entry.key.length > 0, `registry '${this.name}' rejects an empty key`);
    if (this.#strict && this.#entries.has(entry.key)) {
      throw new Error(`registry '${this.name}' already has key '${entry.key}'`);
    }
    this.#entries.set(entry.key, entry);
    return this;
  }

  /** Register many at once; convenient for bootstrap modules. */
  registerAll(entries: readonly T[]): this {
    for (const entry of entries) this.register(entry);
    return this;
  }

  /** Replace an existing entry. Used by tenant overlays, not by bootstrap. */
  override(entry: T): this {
    invariant(!this.#sealed, `registry '${this.name}' is sealed`);
    this.#entries.set(entry.key, entry);
    return this;
  }

  get(key: string): T | undefined {
    return this.#entries.get(key);
  }

  /** Resolve or produce a typed error naming the registry and the missing key. */
  require(key: string): Result<T> {
    const entry = this.#entries.get(key);
    if (!entry) {
      return fail(
        ErrorCode.UNKNOWN_REGISTRY_ENTRY,
        `no entry '${key}' in registry '${this.name}'`,
        { registry: this.name, key, available: this.keys().slice(0, 25) },
      );
    }
    return ok(entry);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  keys(): string[] {
    return [...this.#entries.keys()].sort();
  }

  list(): T[] {
    return this.keys().map((k) => this.#entries.get(k) as T);
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Freeze the registry. Bootstrap seals registries before serving traffic. */
  seal(): this {
    this.#sealed = true;
    return this;
  }

  get sealed(): boolean {
    return this.#sealed;
  }

  /** A child registry that inherits these entries and can add or shadow them. */
  fork(name: string): Registry<T> {
    const child = new Registry<T>(name, { strict: false });
    for (const [key, entry] of this.#entries) child.override({ ...entry, key });
    return child;
  }

  /** Machine-readable description of this registry, for docs and governance. */
  describe(): { registry: string; sealed: boolean; entries: RegistryEntry[] } {
    return {
      registry: this.name,
      sealed: this.#sealed,
      entries: this.list().map((e) => ({
        key: e.key,
        label: e.label,
        ...(e.description === undefined ? {} : { description: e.description }),
        ...(e.version === undefined ? {} : { version: e.version }),
        ...(e.deprecated === undefined ? {} : { deprecated: e.deprecated }),
      })),
    };
  }
}
