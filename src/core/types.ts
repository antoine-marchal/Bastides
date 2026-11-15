/** Fundamental shared types. No dependency on DOM, Canvas, Tauri or network. */

export enum Terrain {
  GRASS = 0,
  ROAD = 1,
  CITY = 2,
}

/** Sides in clockwise order: 0 = NORTH, 1 = EAST, 2 = SOUTH, 3 = WEST. */
export type Side = 0 | 1 | 2 | 3;
export type Rotation = 0 | 1 | 2 | 3;
export const SIDES: readonly Side[] = [0, 1, 2, 3];
export const SIDE_NAMES = ["N", "E", "S", "W"] as const;

export type TileEdges = readonly [Terrain, Terrain, Terrain, Terrain];

/** Field port index 0..7 clockwise: N0, N1, E0, E1, S0, S1, W0, W1. */
export type FieldPort = number;
export const PORT_NAMES = ["N0", "N1", "E0", "E1", "S0", "S1", "W0", "W1"] as const;

export interface CityRegion {
  id: number;
  sides: Side[];
  shields: number;
}

export interface RoadRegion {
  id: number;
  sides: Side[];
  terminalIds: number[];
}

export interface FieldRegion {
  id: number;
  ports: FieldPort[];
  adjacentCityIds: number[];
}

export type TerminalKind = "junction" | "cityGate" | "monastery" | "village";

export interface RoadTerminal {
  id: number;
  kind: TerminalKind;
  cityId?: number;
}

export interface TileTopology {
  /** Stable, versioned signature (see procedural/topology/generator.ts). */
  id: string;
  edges: TileEdges;
  cities: CityRegion[];
  roads: RoadRegion[];
  fields: FieldRegion[];
  terminals: RoadTerminal[];
  monastery: boolean;
}

export type FeatureKind = "city" | "road" | "field" | "monastery";

/** A tile as it exists in a deck: purely logical, a few bytes. */
export interface TileDef {
  topologyId: string;
  /** Per-tile uint32 from which topology/geometry/visual seeds are derived by domain. */
  seed: number;
}

export interface Pt {
  x: number;
  y: number;
}

export const TILE_SIZE = 128;
export const ROAD_WIDTH = 16;

export const RULES_VERSION = 1;
export const GENERATOR_VERSION = 1;
export const SAVE_FORMAT_VERSION = 1;
export const PROTOCOL_VERSION = 1;
