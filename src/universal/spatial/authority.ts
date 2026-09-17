/**
 * Spatial Authority.
 *
 * Answers exactly three questions, which is all any incentive has ever needed:
 *   - where is this node in the containment tree?
 *   - does scope S include node N?
 *   - which jurisdiction governs node N?
 *
 * Distance and geometry are deliberately absent from the core. A tenant that
 * needs "within 5 km of a store" registers a proximity resolver and feeds the
 * answer in as a context fact, keeping geometry out of the decision path where
 * it would be impossible to replay deterministically.
 */
import type { Result } from "../../kernel/result.ts";
import { fail, ok } from "../../kernel/result.ts";
import { ErrorCode } from "../../kernel/errors.ts";
import type { Registry } from "../../registry/registry.ts";
import type { CoordinateSystem, SpatialNode, SpatialNodeKind } from "./node.ts";
import {
  DEFAULT_SPATIAL_NODES,
  coordinateSystemRegistry,
  spatialNodeKindRegistry,
  spatialNodeRegistry,
} from "./node.ts";

/**
 * Where an offer applies. Include wins by containment, exclude wins absolutely.
 * An empty `include` means everywhere, which is the sane default for a tenant
 * that has not thought about geography yet.
 */
export interface SpatialScope {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface ScopeVerdict {
  readonly inside: boolean;
  /** The include node that matched, for the decision trace. */
  readonly matchedBy?: string;
  /** The exclude node that vetoed, for the decision trace. */
  readonly excludedBy?: string;
}

/** Guards against a cycle introduced by a bad registry edit. */
const MAX_DEPTH = 64;

export class SpatialAuthority {
  readonly nodes: Registry<SpatialNode>;
  readonly kinds: Registry<SpatialNodeKind>;
  readonly coordinateSystems: Registry<CoordinateSystem>;
  readonly #pathCache = new Map<string, string[]>();

  constructor(options?: {
    nodes?: Registry<SpatialNode>;
    kinds?: Registry<SpatialNodeKind>;
    coordinateSystems?: Registry<CoordinateSystem>;
  }) {
    this.nodes = options?.nodes ?? spatialNodeRegistry().registerAll(DEFAULT_SPATIAL_NODES);
    this.kinds = options?.kinds ?? spatialNodeKindRegistry();
    this.coordinateSystems = options?.coordinateSystems ?? coordinateSystemRegistry();
  }

  /** Node keys from the root down to and including `key`. */
  path(key: string): Result<string[]> {
    const cached = this.#pathCache.get(key);
    if (cached) return ok(cached);

    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = key;

    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        return fail(ErrorCode.INVALID_REQUEST, `spatial hierarchy contains a cycle at '${cursor}'`, { key, chain });
      }
      if (chain.length > MAX_DEPTH) {
        return fail(ErrorCode.INVALID_REQUEST, `spatial hierarchy deeper than ${MAX_DEPTH} at '${key}'`);
      }
      seen.add(cursor);
      const node = this.nodes.require(cursor);
      if (!node.ok) return node;
      chain.unshift(cursor);
      cursor = node.value.parent;
    }

    this.#pathCache.set(key, chain);
    return ok(chain);
  }

  /** Is `descendant` inside `ancestor`, or the same node? */
  contains(ancestor: string, descendant: string): Result<boolean> {
    const path = this.path(descendant);
    return path.ok ? ok(path.value.includes(ancestor)) : path;
  }

  /** Nearest ancestor of the given kind, e.g. "which body is this site on?". */
  ancestorOfKind(key: string, kind: string): Result<SpatialNode | undefined> {
    const path = this.path(key);
    if (!path.ok) return path;
    for (let i = path.value.length - 1; i >= 0; i -= 1) {
      const node = this.nodes.get(path.value[i] as string);
      if (node?.kind === kind) return ok(node);
    }
    return ok(undefined);
  }

  /** Nearest declared jurisdiction walking up the tree. */
  jurisdictionOf(key: string): Result<string | undefined> {
    const path = this.path(key);
    if (!path.ok) return path;
    for (let i = path.value.length - 1; i >= 0; i -= 1) {
      const node = this.nodes.get(path.value[i] as string);
      if (node?.jurisdiction) return ok(node.jurisdiction);
    }
    return ok(undefined);
  }

  /** Evaluate a scope against a node, explaining which rule decided it. */
  evaluateScope(scope: SpatialScope, key: string): Result<ScopeVerdict> {
    const path = this.path(key);
    if (!path.ok) return path;
    const ancestry = path.value;

    for (const excluded of scope.exclude ?? []) {
      if (ancestry.includes(excluded)) return ok({ inside: false, excludedBy: excluded });
    }

    const include = scope.include ?? [];
    if (include.length === 0) return ok({ inside: true });

    for (const included of include) {
      if (ancestry.includes(included)) return ok({ inside: true, matchedBy: included });
    }
    return ok({ inside: false });
  }

  /** All registered descendants of a node. Used by consoles and reporting. */
  descendantsOf(key: string): Result<SpatialNode[]> {
    const found: SpatialNode[] = [];
    for (const node of this.nodes.list()) {
      const inside = this.contains(key, node.key);
      if (!inside.ok) return inside;
      if (inside.value && node.key !== key) found.push(node);
    }
    return ok(found);
  }

  /** Invalidate the path cache after a registry mutation. */
  invalidate(): void {
    this.#pathCache.clear();
  }
}
