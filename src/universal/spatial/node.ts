/**
 * Spatial nodes.
 *
 * A place is a node in a tree with a kind. There is no `country` column, no
 * `city` column and no latitude/longitude assumption, because "country" is a
 * governance concept that does not survive contact with a lunar colony, a duty
 * free zone, an offshore platform or a game world.
 *
 * Containment is the only question the eligibility engine ever asks, and a tree
 * answers it in O(depth) with no geometry at all.
 */
import type { RegistryEntry } from "../../registry/registry.ts";
import { Registry } from "../../registry/registry.ts";

/** What kind of place this is. Registry-driven, so tenants add their own. */
export interface SpatialNodeKind extends RegistryEntry {
  /** Rank for display and validation; lower numbers contain higher ones. */
  readonly depthHint: number;
}

export interface Coordinates {
  /** Key into the coordinate-system registry. */
  readonly system: string;
  /** Ordered values, interpreted by the coordinate system's `axes`. */
  readonly values: readonly number[];
}

export interface SpatialNode extends RegistryEntry {
  /** Parent node key. Absent for a root (a planet, a game universe). */
  readonly parent?: string;
  /** Key into the spatial-node-kind registry. */
  readonly kind: string;
  /** Optional position; many nodes (a sales territory) legitimately have none. */
  readonly coordinates?: Coordinates;
  /**
   * Governance authority effective here, e.g. a tax or compliance jurisdiction.
   * Kept separate from the containment tree because they genuinely diverge:
   * an embassy sits inside one place and under another's law.
   */
  readonly jurisdiction?: string;
}

export interface CoordinateSystem extends RegistryEntry {
  /** Axis names in order, e.g. ["latitude","longitude"] or ["x","y","z"]. */
  readonly axes: readonly string[];
  /** Unit per axis, e.g. ["degree","degree"] or ["metre","metre","metre"]. */
  readonly axisUnits: readonly string[];
  /** Does the system wrap (a sphere) or extend indefinitely (a plane)? */
  readonly topology: "spherical" | "cartesian" | "graph";
}

export const DEFAULT_NODE_KINDS: SpatialNodeKind[] = [
  { key: "universe", label: "Universe", depthHint: 0 },
  { key: "galaxy", label: "Galaxy", depthHint: 1 },
  { key: "system", label: "Star system", depthHint: 2 },
  { key: "body", label: "Planetary body", depthHint: 3 },
  { key: "territory", label: "Territory", depthHint: 4 },
  { key: "region", label: "Region", depthHint: 5 },
  { key: "locality", label: "Locality", depthHint: 6 },
  { key: "site", label: "Site or store", depthHint: 7 },
  { key: "zone", label: "Logical zone", depthHint: 8, description: "Non-geographic: a delivery zone, a duty-free area, a shard." },
  { key: "virtual", label: "Virtual place", depthHint: 8, description: "A game world, a marketplace surface, a channel." },
];

export const DEFAULT_COORDINATE_SYSTEMS: CoordinateSystem[] = [
  {
    key: "wgs84",
    label: "WGS-84 geodetic",
    axes: ["latitude", "longitude"],
    axisUnits: ["degree", "degree"],
    topology: "spherical",
  },
  {
    key: "mars.areocentric",
    label: "Areocentric Mars coordinates",
    axes: ["latitude", "longitude"],
    axisUnits: ["degree", "degree"],
    topology: "spherical",
  },
  {
    key: "grid.local",
    label: "Local Cartesian grid",
    description: "Floor plans, warehouses, habitat decks, game maps.",
    axes: ["x", "y", "z"],
    axisUnits: ["metre", "metre", "metre"],
    topology: "cartesian",
  },
];

export function spatialNodeRegistry(): Registry<SpatialNode> {
  return new Registry<SpatialNode>("spatial-node");
}

export function spatialNodeKindRegistry(): Registry<SpatialNodeKind> {
  return new Registry<SpatialNodeKind>("spatial-node-kind").registerAll(DEFAULT_NODE_KINDS);
}

export function coordinateSystemRegistry(): Registry<CoordinateSystem> {
  return new Registry<CoordinateSystem>("coordinate-system").registerAll(DEFAULT_COORDINATE_SYSTEMS);
}

/** A worked hierarchy, used by the examples and the tests. */
export const DEFAULT_SPATIAL_NODES: SpatialNode[] = [
  { key: "sol", label: "Sol system", kind: "system" },
  { key: "earth", label: "Earth", kind: "body", parent: "sol" },
  { key: "earth.in", label: "India", kind: "territory", parent: "earth", jurisdiction: "IN" },
  { key: "earth.in.br", label: "Bihar", kind: "region", parent: "earth.in", jurisdiction: "IN-BR" },
  { key: "earth.in.br.patna", label: "Patna", kind: "locality", parent: "earth.in.br" },
  { key: "earth.in.br.patna.store-01", label: "Patna Store 01", kind: "site", parent: "earth.in.br.patna" },
  { key: "earth.in.mh", label: "Maharashtra", kind: "region", parent: "earth.in", jurisdiction: "IN-MH" },
  { key: "earth.in.mh.mumbai", label: "Mumbai", kind: "locality", parent: "earth.in.mh" },
  { key: "earth.us", label: "United States", kind: "territory", parent: "earth", jurisdiction: "US" },
  { key: "earth.us.ny", label: "New York", kind: "region", parent: "earth.us", jurisdiction: "US-NY" },
  { key: "luna", label: "Luna", kind: "body", parent: "sol" },
  { key: "luna.alpha", label: "Colony Alpha", kind: "territory", parent: "luna", jurisdiction: "LUNA-ACC" },
  { key: "mars", label: "Mars", kind: "body", parent: "sol" },
  { key: "mars.olympus", label: "Olympus Territory", kind: "territory", parent: "mars", jurisdiction: "MARS-OT" },
  { key: "mars.olympus.sector-7", label: "Sector 7", kind: "region", parent: "mars.olympus" },
  { key: "net.marketplace", label: "Marketplace surface", kind: "virtual" },
  { key: "net.marketplace.app", label: "Marketplace mobile app", kind: "virtual", parent: "net.marketplace" },
];
