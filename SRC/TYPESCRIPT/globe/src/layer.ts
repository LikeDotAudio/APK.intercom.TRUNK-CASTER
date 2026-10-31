// The layer contract. A layer is one thing the map can draw (sun, trunks,
// calls, …). The engine draws the sea and the land, then every enabled layer
// in registry order, once per pane and once per repeated copy of the flat
// map. A new layer plugs in with registerLayer(); its chip appears in the
// toolbar (#mapbar) and its on/off state is remembered per page like the rest.

import type { Filter } from './state.ts';
import type { XY, XYZ } from './math.ts';
import type {
  ColourView,
  GlobeConfig,
  GlobeData,
  GlobeNode,
  Hub,
  LandRing,
  LiveTrunk,
  Projection,
  TrunkHistory,
} from './types.ts';

export interface PaneSpec {
  p: Projection;
  x: number;
  w: number;
}

/** The camera: what proj() needs, plus the geometry helpers built on it. */
export interface MapView {
  readonly projection: Projection;
  readonly pane: PaneSpec;
  readonly zoom: number;
  readonly H: number;
  /** Pixel radius of the current pane. */
  R(): number;
  CX(): number;
  CY(): number;
  mapW(): number;
  /** Degrees the world is turned now (frozen while hovering a frame). */
  rot(): number;
  proj(lat: number, lon: number): XYZ;
  /** On the map, the copy of q nearest p. */
  near(p: XYZ, q: XYZ): XYZ;
  lift(p: XY, q: XY, amount: number): XY;
}

/** What a trunk arc stands for: the live trunk, its history, or both. */
export interface TrunkRec {
  live?: LiveTrunk | undefined;
  hist?: TrunkHistory | undefined;
}
export interface ArcMid extends XY {
  front: boolean;
}
export interface ArcHit {
  pts: Array<[number, number]>;
  rec: TrunkRec;
  m: ArcMid;
}

export interface ContinentNode {
  name: string;
  frames: number;
  live: number;
  la: number;
  sx: number;
  sy: number;
  n: number;
  homeTrunks: number;
  homeCalls: number;
  sites: Set<string>;
  lat: number;
  lon: number;
}
export interface ContinentLink {
  a: string;
  b: string;
  trunks: number;
  used: number;
  cap: number;
  calls: number;
  uses: number;
}
export type ContHit =
  | { kind: 'link'; l: ContinentLink; x: number; y: number; r: number }
  | { kind: 'node'; c: ContinentNode; links: ContinentLink[]; x: number; y: number; r: number };

/** Things drawn this frame that the pointer can find. Cleared once per frame. */
export interface Hits {
  arcs: ArcHit[];
  cont: ContHit[];
}

/** The engine as layers see it. */
export interface Engine {
  readonly ctx: CanvasRenderingContext2D;
  readonly view: MapView;
  readonly data: GlobeData;
  readonly byId: ReadonlyMap<string, GlobeNode>;
  readonly histByKey: ReadonlyMap<string, TrunkHistory>;
  readonly filter: Filter;
  readonly hub: Hub | null;
  readonly land: readonly LandRing[];
  readonly hits: Hits;
  readonly hover: string | null;
  readonly colour: ColourView;
  readonly focus: string | null;
  cfg(): GlobeConfig;
  on(key: string): boolean;
}

/** One draw pass: one pane, one copy of the map. */
export interface Scene {
  readonly g: Engine;
  readonly ctx: CanvasRenderingContext2D;
  /** Seconds (Date.now()/1000), shared by every pane this frame. */
  readonly t: number;
  /** Every node projected for this pass. */
  readonly pos: ReadonlyMap<string, XYZ>;
}

export interface Layer {
  /** Toolbar key; also the sessionStorage name in `globe.layers<PAGE>`. */
  readonly key: string;
  /** Default: `g.on(key)`. */
  isOn?(g: Engine): boolean;
  /** Once per pane per frame, before the map's copies are drawn. */
  prepare?(g: Engine, pane: PaneSpec): void;
  draw(s: Scene): void;
}

export interface Chip {
  key: string;
  label: string;
  /** Hide the chip unless this holds (Data ports needs a hub). */
  when?: () => boolean;
}

const registry: Layer[] = [];
const chips: Chip[] = [];

/** Add a layer to the draw order (end, or before `before`) and, with a label, a toolbar chip. */
export function registerLayer(layer: Layer, opts: { before?: string; chip?: Omit<Chip, 'key'> } = {}): void {
  const i = opts.before ? registry.findIndex((l) => l.key === opts.before) : -1;
  if (i >= 0) registry.splice(i, 0, layer);
  else registry.push(layer);
  if (opts.chip) chips.push({ key: layer.key, ...opts.chip });
}

/** Toolbar chips in GLOBE_JS's ALL_LAYERS order (not draw order). */
export function defineChips(list: Chip[]): void {
  chips.length = 0;
  chips.push(...list);
}

export const layers = (): readonly Layer[] => registry;
export const chipList = (): readonly Chip[] => chips;
