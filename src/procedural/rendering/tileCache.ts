/** Bounded LRU cache of rendered tiles (in memory only; never written to disk). */
import type { TileDef } from "../../core/types";
import { generateGeometry, geometrySeedOf, visualSeedOf } from "../geometry/tileGeometry";
import { renderTile } from "./tileRenderer";
import type { Ctx } from "./tileRenderer";

export type TileBitmap = HTMLCanvasElement | OffscreenCanvas;

export function makeCanvas(w: number, h: number): TileBitmap {
  // OffscreenCanvas when the WebView has it; a detached <canvas> otherwise.
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

export class TileCache {
  private map = new Map<string, TileBitmap>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  constructor(private maxBytes = 96 * 1024 * 1024) {}

  static key(def: TileDef, rotation: number, tx: number, ty: number, px: number): string {
    return `${def.topologyId}#${def.seed}@${rotation}:${tx},${ty}:${px}`;
  }
  peek(key: string): TileBitmap | undefined {
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); this.hits++; }
    return hit;
  }
  /** Render (or fetch) a tile at the given pixel size. */
  get(def: TileDef, rotation: number, tx: number, ty: number, px: number): TileBitmap {
    const key = TileCache.key(def, rotation, tx, ty, px);
    const hit = this.peek(key);
    if (hit) return hit;
    this.misses++;
    const canvas = makeCanvas(px, px);
    const ctx = canvas.getContext("2d") as Ctx;
    const g = generateGeometry(def.topologyId, geometrySeedOf(def.seed));
    renderTile(ctx, g, { px, tx, ty, rotation, visualSeed: visualSeedOf(def.seed), detail: px <= 64 ? 0 : px >= 256 ? 2 : 1 });
    this.map.set(key, canvas);
    this.bytes += px * px * 4;
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const [oldKey, old] = this.map.entries().next().value!;
      this.map.delete(oldKey);
      this.bytes -= old.width * old.height * 4;
    }
    return canvas;
  }
  get size(): number { return this.map.size; }
  get memoryBytes(): number { return this.bytes; }
  clear(): void { this.map.clear(); this.bytes = 0; }
}
