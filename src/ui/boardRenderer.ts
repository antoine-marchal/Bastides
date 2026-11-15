/**
 * Interactive board on a single Canvas: camera, viewport culling, LOD, cached tiles,
 * overlays (legal cells, ghost tile, meeple spots, region highlight, score pop-ups).
 * It renders only when something changed and never mutates the game state.
 */
import { TILE_SIZE } from "../core/types";
import type { TileDef } from "../core/types";
import { cellKey } from "../core/coordinates";
import { K_CITY, K_FIELD, K_MONASTERY, K_ROAD } from "../procedural/geometry/masks";
import { featureAt, generateGeometry, geometrySeedOf, rotatedAnchor } from "../procedural/geometry/tileGeometry";
import { getTopology } from "../procedural/topology/catalog";
import { drawMeeple } from "../procedural/rendering/tileRenderer";
import { TileCache, makeCanvas } from "../procedural/rendering/tileCache";
import type { TileBitmap } from "../procedural/rendering/tileCache";
import type { MeepleOption } from "../game/gameEngine";
import type { GameState } from "../game/state";
import { PLAYER_COLORS } from "./dom";

const S = TILE_SIZE;

export interface Ghost { def: TileDef; x: number; y: number; rotation: number; legal: boolean }
export interface Spot { option: MeepleOption; x: number; y: number }
export interface Highlight { features: Map<number, Set<number>>; color: string }
interface Popup { x: number; y: number; text: string; color: string; t0: number }
interface PointerPosition { x: number; y: number }

export class BoardView {
  camera = { x: S / 2, y: S / 2, zoom: 1 };
  legalCells: { x: number; y: number }[] = [];
  ghost: Ghost | null = null;
  spots: Spot[] = [];
  highlight: Highlight | null = null;
  lastTile = -1;
  showLegal = true;
  interactive = true;
  quarterTurns = 0;
  onCellClick: ((x: number, y: number, feature: number, tileIndex: number) => void) | null = null;
  onCellHover: ((x: number, y: number) => void) | null = null;
  onSpotClick: ((spot: Spot) => void) | null = null;
  onRotate: (() => void) | null = null;
  /** Rendering statistics of the last frame (performance HUD and benchmarks). */
  stats = { frameMs: 0, drawn: 0, generated: 0, frames: 0 };

  private state: GameState | null = null;
  private ctx: CanvasRenderingContext2D;
  private dirty = true;
  private raf = 0;
  private popups: Popup[] = [];
  private hlCache = new Map<string, TileBitmap>();
  private ro: ResizeObserver;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null = null;
  private touches = new Map<number, PointerPosition>();
  private disposed = false;

  constructor(readonly canvas: HTMLCanvasElement, readonly cache: TileCache) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.ro = new ResizeObserver(() => this.requestRender());
    this.ro.observe(canvas);
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onCancel);
    canvas.addEventListener("lostpointercapture", this.onCancel);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); this.onRotate?.(); });
    this.requestRender();
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
  }

  setState(state: GameState | null): void {
    this.state = state;
    this.requestRender();
  }
  getState(): GameState | null { return this.state; }

  setHighlight(hl: Highlight | null): void { this.highlight = hl; this.hlCache.clear(); this.requestRender(); }

  requestRender(): void {
    this.dirty = true;
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.frame);
  }

  addPopup(tx: number, ty: number, text: string, color: string): void {
    this.popups.push({ x: (tx + 0.5) * S, y: (ty + 0.5) * S, text, color, t0: performance.now() });
    this.requestRender();
  }

  centerOn(tx: number, ty: number, animate = true): void {
    const target = { x: (tx + 0.5) * S, y: (ty + 0.5) * S };
    if (!animate) { this.camera.x = target.x; this.camera.y = target.y; this.requestRender(); return; }
    const from = { ...this.camera }, t0 = performance.now();
    const step = () => {
      if (this.disposed) return;
      const k = Math.min(1, (performance.now() - t0) / 280), e = 1 - (1 - k) * (1 - k);
      this.camera.x = from.x + (target.x - from.x) * e; this.camera.y = from.y + (target.y - from.y) * e;
      this.requestRender();
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  /** Fit the whole board in view. */
  fit(): void {
    const s = this.state;
    if (!s || !s.tiles.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of s.tiles) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x); y1 = Math.max(y1, t.y); }
    const w = this.canvas.clientWidth || 800, hgt = this.canvas.clientHeight || 600;
    this.camera.x = ((x0 + x1 + 1) / 2) * S; this.camera.y = ((y0 + y1 + 1) / 2) * S;
    this.camera.zoom = Math.max(0.1, Math.min(1.5, Math.min(w / ((x1 - x0 + 3) * S), hgt / ((y1 - y0 + 3) * S))));
    this.requestRender();
  }

  /** True when tile (tx, ty) is far from the visible centre (used for auto-centring). */
  isOffCentre(tx: number, ty: number): boolean {
    const w = this.canvas.clientWidth, hgt = this.canvas.clientHeight, z = this.camera.zoom;
    const sx = ((tx + 0.5) * S - this.camera.x) * z, sy = ((ty + 0.5) * S - this.camera.y) * z;
    return Math.abs(sx) > w * 0.36 || Math.abs(sy) > hgt * 0.36;
  }

  screenToWorld(px: number, py: number): { x: number; y: number } {
    const w = this.canvas.clientWidth, hgt = this.canvas.clientHeight;
    return { x: (px - w / 2) / this.camera.zoom + this.camera.x, y: (py - hgt / 2) / this.camera.zoom + this.camera.y };
  }

  // ------------------------------------------------------------------ input
  private pointerPosition(e: MouseEvent): PointerPosition {
    const bounds = this.canvas.getBoundingClientRect();
    switch (this.quarterTurns) {
      case 1: return { x: e.clientY - bounds.top, y: bounds.right - e.clientX };
      case 2: return { x: bounds.right - e.clientX, y: bounds.bottom - e.clientY };
      case 3: return { x: bounds.bottom - e.clientY, y: e.clientX - bounds.left };
      default: return { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
    }
  }
  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const point = this.pointerPosition(e);
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, point);
      if (this.touches.size > 1) { this.drag = null; return; }
    }
    if (this.drag || this.touches.size > 1) return;
    this.drag = { ...point, cx: this.camera.x, cy: this.camera.y, moved: false, id: e.pointerId };
  };
  private onMove = (e: PointerEvent): void => {
    const point = this.pointerPosition(e);
    if (this.touches.has(e.pointerId)) {
      const before = this.pinchGeometry();
      this.touches.set(e.pointerId, point);
      const after = this.pinchGeometry();
      if (before && after) {
        const scale = before.distance > 0 && after.distance > 0 ? after.distance / before.distance : 1;
        this.zoomAt(scale, before, after);
        return;
      }
    }
    if (this.drag) {
      if (this.drag.id !== e.pointerId) return;
      const dx = point.x - this.drag.x, dy = point.y - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < 5) return;
      this.drag.moved = true;
      this.camera.x = this.drag.cx - dx / this.camera.zoom;
      this.camera.y = this.drag.cy - dy / this.camera.zoom;
      this.canvas.style.cursor = "grabbing";
      this.requestRender();
      return;
    }
    const w = this.screenToWorld(point.x, point.y);
    this.onCellHover?.(Math.floor(w.x / S), Math.floor(w.y / S));
  };
  private pinchGeometry(): (PointerPosition & { distance: number }) | null {
    if (this.touches.size < 2) return null;
    const [a, b] = this.touches.values();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  }
  private onCancel = (e: PointerEvent): void => {
    if (this.touches.delete(e.pointerId) && this.touches.size === 1 && !this.drag) {
      const [[id, point]] = this.touches;
      this.drag = { ...point, cx: this.camera.x, cy: this.camera.y, moved: true, id };
    }
    if (this.drag?.id === e.pointerId) {
      this.drag = null;
      this.canvas.style.cursor = "";
    }
  };
  private onUp = (e: PointerEvent): void => {
    const d = this.drag?.id === e.pointerId ? this.drag : null;
    this.onCancel(e);
    if (!d || d.moved || !this.interactive) return;
    const z = this.camera.zoom;
    const point = this.pointerPosition(e);
    const w = this.screenToWorld(point.x, point.y);
    let best: Spot | null = null, bestD = Math.max(15, 13 * z);
    for (const s of this.spots) {
      const dist = Math.hypot(s.x - w.x, s.y - w.y) * z;
      if (dist < bestD) { best = s; bestD = dist; }
    }
    if (best) { this.onSpotClick?.(best); return; }
    const tx = Math.floor(w.x / S), ty = Math.floor(w.y / S);
    let feature = -1, tileIndex = -1;
    const st = this.state;
    if (st) {
      const ti = st.board.get(cellKey(tx, ty));
      if (ti !== undefined) {
        const t = st.tiles[ti];
        tileIndex = ti;
        feature = featureAt(generateGeometry(t.def.topologyId, geometrySeedOf(t.def.seed)), t.rotation, w.x - tx * S, w.y - ty * S);
      }
    }
    this.onCellClick?.(tx, ty, feature, tileIndex);
  };
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const dz = Math.exp(-(e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY) * 0.0016);
    const point = this.pointerPosition(e);
    this.zoomAt(dz, point, point);
  };
  private zoomAt(scale: number, from: PointerPosition, to: PointerPosition): void {
    const before = this.screenToWorld(from.x, from.y);
    this.camera.zoom = Math.max(0.08, Math.min(5, this.camera.zoom * scale));
    const after = this.screenToWorld(to.x, to.y);
    this.camera.x += before.x - after.x; this.camera.y += before.y - after.y;
    this.requestRender();
  }

  // ------------------------------------------------------------------ drawing
  private frame = (): void => {
    this.raf = 0;
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    const t0 = performance.now();
    const again = this.render(t0);
    this.stats.frameMs = performance.now() - t0;
    this.stats.frames++;
    if (again) this.requestRender();
  };

  private lodPx(): number {
    const target = S * this.camera.zoom * (window.devicePixelRatio || 1);
    return target <= 84 ? 64 : target <= 210 ? 128 : 256;
  }

  private highlightBitmap(def: TileDef, rotation: number, features: Set<number>, color: string): TileBitmap {
    const key = `${def.topologyId}#${def.seed}@${rotation}:${[...features].join(",")}:${color}`;
    let bmp = this.hlCache.get(key);
    if (bmp) return bmp;
    const g = generateGeometry(def.topologyId, geometrySeedOf(def.seed));
    const t = getTopology(def.topologyId);
    bmp = makeCanvas(S, S);
    const c = bmp.getContext("2d") as CanvasRenderingContext2D;
    const img = c.createImageData(S, S);
    const rgb = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
    const nc = t.cities.length, nr = t.roads.length, nf = t.fields.length;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      let cx = i, cy = j;
      const r = rotation & 3;
      if (r === 1) { cx = j; cy = S - 1 - i; } else if (r === 2) { cx = S - 1 - i; cy = S - 1 - j; } else if (r === 3) { cx = S - 1 - j; cy = i; }
      const k = cy * S + cx, kd = g.mask.kind[k], id = g.mask.id[k];
      const f = kd === K_CITY ? id : kd === K_ROAD ? nc + id : kd === K_FIELD ? nc + nr + id : kd === K_MONASTERY ? nc + nr + nf : -1;
      if (!features.has(f)) continue;
      const p = (j * S + i) * 4;
      img.data[p] = rgb[0]; img.data[p + 1] = rgb[1]; img.data[p + 2] = rgb[2]; img.data[p + 3] = 150;
    }
    c.putImageData(img, 0, 0);
    this.hlCache.set(key, bmp);
    return bmp;
  }

  private render(now: number): boolean {
    const canvas = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (!w || !hgt) return false;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#e6d8b8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const z = this.camera.zoom * dpr;
    const ox = canvas.width / 2 - this.camera.x * z, oy = canvas.height / 2 - this.camera.y * z;
    const sx = (wx: number) => Math.round(ox + wx * z), sy = (wy: number) => Math.round(oy + wy * z);
    const x0 = Math.floor(-ox / z / S), x1 = Math.floor((canvas.width - ox) / z / S);
    const y0 = Math.floor(-oy / z / S), y1 = Math.floor((canvas.height - oy) / z / S);
    let again = false;

    // Parchment grid.
    if (z * S > 26) {
      ctx.strokeStyle = "rgba(120,95,60,0.16)"; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1 + 1; x++) { ctx.moveTo(sx(x * S) + 0.5, 0); ctx.lineTo(sx(x * S) + 0.5, canvas.height); }
      for (let y = y0; y <= y1 + 1; y++) { ctx.moveTo(0, sy(y * S) + 0.5); ctx.lineTo(canvas.width, sy(y * S) + 0.5); }
      ctx.stroke();
    }
    const st = this.state;
    this.stats.drawn = 0; this.stats.generated = 0;
    if (st) {
      const px = this.lodPx();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const visible = (x1 - x0 + 1) * (y1 - y0 + 1);
      const drawTile = (ti: number) => {
        const t = st.tiles[ti];
        const dx = sx(t.x * S), dy = sy(t.y * S), dw = sx((t.x + 1) * S) - dx, dh = sy((t.y + 1) * S) - dy;
        const key = TileCache.key(t.def, t.rotation, t.x, t.y, px);
        let bmp = this.cache.peek(key);
        if (!bmp) {
          // Generate outside of the hot path: a few milliseconds per frame, the rest next frame.
          if (performance.now() - now < 9 || this.stats.generated === 0) { bmp = this.cache.get(t.def, t.rotation, t.x, t.y, px); this.stats.generated++; }
          else { again = true; ctx.fillStyle = "#93b05c"; ctx.fillRect(dx, dy, dw, dh); return; }
        }
        ctx.drawImage(bmp as CanvasImageSource, dx, dy, dw, dh);
        this.stats.drawn++;
      };
      if (visible < st.tiles.length) {
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const ti = st.board.get(cellKey(x, y)); if (ti !== undefined) drawTile(ti); }
      } else for (let ti = 0; ti < st.tiles.length; ti++) { const t = st.tiles[ti]; if (t.x >= x0 && t.x <= x1 && t.y >= y0 && t.y <= y1) drawTile(ti); }

      // Region highlight.
      if (this.highlight) for (const [ti, feats] of this.highlight.features) {
        const t = st.tiles[ti];
        if (!t || t.x < x0 || t.x > x1 || t.y < y0 || t.y > y1) continue;
        const dx = sx(t.x * S), dy = sy(t.y * S);
        ctx.drawImage(this.highlightBitmap(t.def, t.rotation, feats, this.highlight.color) as CanvasImageSource, dx, dy, sx((t.x + 1) * S) - dx, sy((t.y + 1) * S) - dy);
      }
      // Last placed tile.
      if (this.lastTile >= 0 && st.tiles[this.lastTile]) {
        const t = st.tiles[this.lastTile];
        ctx.strokeStyle = "rgba(255,246,214,0.9)"; ctx.lineWidth = Math.max(2, 2 * dpr);
        ctx.strokeRect(sx(t.x * S) + 1, sy(t.y * S) + 1, sx((t.x + 1) * S) - sx(t.x * S) - 2, sy((t.y + 1) * S) - sy(t.y * S) - 2);
      }
      // Legal cells: a discreet colour code.
      if (this.showLegal) for (const c of this.legalCells) {
        if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
        const dx = sx(c.x * S), dy = sy(c.y * S), dw = sx((c.x + 1) * S) - dx, dh = sy((c.y + 1) * S) - dy;
        ctx.fillStyle = "rgba(96,140,70,0.20)"; ctx.fillRect(dx + 3, dy + 3, dw - 6, dh - 6);
        ctx.strokeStyle = "rgba(70,110,50,0.75)"; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 5 * dpr]);
        ctx.strokeRect(dx + 3.5, dy + 3.5, dw - 7, dh - 7); ctx.setLineDash([]);
      }
      // Ghost of the tile being placed.
      if (this.ghost) {
        const g = this.ghost;
        const dx = sx(g.x * S), dy = sy(g.y * S), dw = sx((g.x + 1) * S) - dx, dh = sy((g.y + 1) * S) - dy;
        ctx.globalAlpha = g.legal ? 0.92 : 0.55;
        ctx.drawImage(this.cache.get(g.def, g.rotation, g.x, g.y, px === 64 ? 128 : px) as CanvasImageSource, dx, dy, dw, dh);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = g.legal ? "#f7e9a8" : "#c0392b"; ctx.lineWidth = 3 * dpr;
        ctx.strokeRect(dx + 1.5, dy + 1.5, dw - 3, dh - 3);
        if (!g.legal) { ctx.fillStyle = "rgba(192,57,43,0.25)"; ctx.fillRect(dx, dy, dw, dh); }
      }
      // Meeples.
      const msize = Math.max(11 * dpr, 24 * z);
      for (const region of st.regions.values()) for (const m of region.meeples) {
        const t = st.tiles[m.tile];
        if (t.x < x0 - 1 || t.x > x1 + 1 || t.y < y0 - 1 || t.y > y1 + 1) continue;
        const a = rotatedAnchor(generateGeometry(t.def.topologyId, geometrySeedOf(t.def.seed)), t.rotation, m.feature);
        drawMeeple(ctx, ox + (t.x * S + a.x) * z, oy + (t.y * S + a.y) * z, msize, PLAYER_COLORS[st.config.players[m.player].color], region.kind === "field");
      }
      // Meeple spots of the tile just placed.
      for (const s of this.spots) {
        const cx = ox + s.x * z, cy = oy + s.y * z, r = Math.max(9 * dpr, 11 * z);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.2832);
        if (s.option.allowed) {
          ctx.fillStyle = "rgba(255,250,225,0.88)"; ctx.fill();
          ctx.strokeStyle = "#4a3a22"; ctx.lineWidth = 2 * dpr; ctx.stroke();
          const glyph = { city: "#b4553a", road: "#b59a68", field: "#6f9c44", monastery: "#6c7f96" }[s.option.kind];
          ctx.fillStyle = glyph; ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, 6.2832); ctx.fill();
        } else {
          ctx.fillStyle = "rgba(90,80,70,0.55)"; ctx.fill();
          ctx.strokeStyle = "rgba(40,30,20,0.8)"; ctx.lineWidth = 2 * dpr; ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx - r * 0.6, cy - r * 0.6); ctx.lineTo(cx + r * 0.6, cy + r * 0.6); ctx.stroke();
        }
      }
    }
    // Score pop-ups.
    if (this.popups.length) {
      this.popups = this.popups.filter((p) => now - p.t0 < 2200);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const p of this.popups) {
        const k = Math.max(0, (now - p.t0) / 2200);
        const size = Math.max(18, 30 * Math.min(1.4, this.camera.zoom + 0.4)) * dpr;
        ctx.font = `bold ${size}px Georgia, "Times New Roman", serif`;
        ctx.globalAlpha = k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25;
        const x = ox + p.x * z, y = oy + p.y * z - k * 60 * dpr;
        ctx.lineWidth = 5 * dpr; ctx.strokeStyle = "rgba(40,28,14,0.85)"; ctx.strokeText(p.text, x, y);
        ctx.fillStyle = p.color; ctx.fillText(p.text, x, y);
      }
      ctx.globalAlpha = 1;
      again = again || this.popups.length > 0;
    }
    return again;
  }
}
