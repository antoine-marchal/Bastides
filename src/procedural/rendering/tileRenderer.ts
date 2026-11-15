/**
 * Procedural tile artwork. Everything is drawn with Canvas 2D primitives from the tile
 * geometry: no bitmap asset, no font, no external resource. The renderer only DRESSES the
 * geometry: it reads masks and shapes and never feeds anything back into the rules.
 */
import { TILE_SIZE } from "../../core/types";
import type { Pt } from "../../core/types";
import { rotatePoint } from "../../core/coordinates";
import { hash2 } from "../../core/hash";
import { createRandom } from "../../core/random";
import { K_CITY } from "../geometry/masks";
import type { TileGeometry } from "../geometry/tileGeometry";
import { generateDecor } from "./decor";
import type { House, Tree } from "./decor";
import { fbm, valueNoise } from "./noise";

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const S = TILE_SIZE;
const GRASS_SEED = 0x9a55, PAVE_SEED = 0x7a1e;
const ROOFS = ["#b4553a", "#c0623f", "#a84a35", "#8f5a44"];
const ROOFS_LIGHT = ["#cf7350", "#d9805a", "#c3654a", "#a8725a"];

/** Soft light coming from the north-west: shadows fall to the south-east. */
const SHX = 1.6, SHY = 2.2;

export function grassColor(wx: number, wy: number): [number, number, number] {
  const n = fbm(wx / 56, wy / 56, GRASS_SEED, 3);
  const m = valueNoise(wx / 9, wy / 9, GRASS_SEED + 5);
  const dry = fbm(wx / 150 + 9, wy / 150, GRASS_SEED + 11, 2);
  const k = n * 0.75 + m * 0.25;
  // Blend between a fresh green and a sunlit yellow-green, with slow dry patches.
  const r = 108 + k * 46 + dry * 26, g = 150 + k * 36 + dry * 6, b = 62 + k * 22 - dry * 10;
  return [r, g, b];
}
function paveColor(wx: number, wy: number): [number, number, number] {
  const n = fbm(wx / 30, wy / 30, PAVE_SEED, 2);
  const m = valueNoise(wx / 4, wy / 4, PAVE_SEED + 3);
  const k = n * 0.7 + m * 0.3;
  return [196 + k * 26, 178 + k * 24, 140 + k * 22];
}

function tracePath(ctx: Ctx, pts: readonly Pt[], close = false): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
}

export function drawHouse(ctx: Ctx, x: number, y: number, w: number, h: number, angle: number, roof: number, seed: number): void {
  const long = w >= h;
  ctx.save();
  ctx.translate(x + SHX, y + SHY);
  ctx.rotate(angle);
  ctx.fillStyle = "rgba(40,30,20,0.28)";
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.restore();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = ROOFS[roof & 3];
  ctx.fillRect(-w / 2, -h / 2, w, h);
  // Pitched roof: the sunlit slope is lighter; the ridge follows the long axis.
  const lit = Math.cos(angle + (long ? Math.PI / 2 : 0) - 2.2) > 0;
  ctx.fillStyle = ROOFS_LIGHT[roof & 3];
  if (long) ctx.fillRect(-w / 2, lit ? -h / 2 : 0, w, h / 2); else ctx.fillRect(lit ? -w / 2 : 0, -h / 2, w / 2, h);
  ctx.strokeStyle = "rgba(70,35,25,0.55)";
  ctx.lineWidth = 0.6;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.beginPath();
  if (long) { ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0); } else { ctx.moveTo(0, -h / 2); ctx.lineTo(0, h / 2); }
  ctx.stroke();
  if ((seed & 7) < 3) { ctx.fillStyle = "#6b5a4a"; ctx.fillRect(long ? w * 0.22 : -0.8, long ? -0.8 : h * 0.22, 1.6, 1.6); } // chimney
  ctx.restore();
}

export function drawTree(ctx: Ctx, x: number, y: number, r: number, conifer: boolean, tone: number): void {
  ctx.fillStyle = "rgba(30,45,20,0.26)";
  ctx.beginPath(); ctx.ellipse(x + SHX * 1.1, y + SHY * 1.1, r, r * 0.9, 0, 0, 6.2832); ctx.fill();
  if (conifer) {
    ctx.fillStyle = tone > 0.5 ? "#2f5b3a" : "#356a40";
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 6.2832, rr = i % 2 ? r * 0.62 : r;
      if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#4a8452";
    ctx.beginPath(); ctx.arc(x - r * 0.18, y - r * 0.2, r * 0.36, 0, 6.2832); ctx.fill();
  } else {
    const dark = tone > 0.66 ? "#4c7a34" : tone > 0.33 ? "#557f38" : "#467335";
    ctx.fillStyle = dark;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
    ctx.fillStyle = tone > 0.5 ? "#6f9c44" : "#79a548";
    ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.28, r * 0.66, 0, 6.2832); ctx.fill();
    ctx.fillStyle = "rgba(190,220,120,0.55)";
    ctx.beginPath(); ctx.arc(x - r * 0.4, y - r * 0.42, r * 0.3, 0, 6.2832); ctx.fill();
  }
}

export function drawTower(ctx: Ctx, x: number, y: number, r: number, slate = false): void {
  ctx.fillStyle = "rgba(40,30,20,0.3)";
  ctx.beginPath(); ctx.arc(x + SHX, y + SHY, r, 0, 6.2832); ctx.fill();
  ctx.fillStyle = "#8f8a7c";
  ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
  ctx.strokeStyle = "rgba(60,55,45,0.7)"; ctx.lineWidth = 0.7; ctx.stroke();
  ctx.fillStyle = slate ? "#5d6f86" : "#a9523a";
  ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, 6.2832); ctx.fill();
  ctx.fillStyle = slate ? "#8497ad" : "#cd7654";
  ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, r * 0.7, 2.6, 4.9); ctx.closePath(); ctx.fill();
}

export function drawWall(ctx: Ctx, path: readonly Pt[]): void {
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.save(); ctx.translate(SHX, SHY);
  tracePath(ctx, path); ctx.strokeStyle = "rgba(40,30,20,0.28)"; ctx.lineWidth = 5.5; ctx.stroke();
  ctx.restore();
  tracePath(ctx, path); ctx.strokeStyle = "#6f6a5d"; ctx.lineWidth = 5.6; ctx.stroke();
  tracePath(ctx, path); ctx.strokeStyle = "#a59f8f"; ctx.lineWidth = 3.8; ctx.stroke();
  ctx.lineCap = "butt";
  tracePath(ctx, path); ctx.strokeStyle = "#c4bead"; ctx.lineWidth = 2.2; ctx.setLineDash([2.2, 2]); ctx.stroke();
  ctx.setLineDash([]);
}

/** Original heraldic device: a seeded two-tincture division on a heater shield. */
export function drawShield(ctx: Ctx, x: number, y: number, seed: number, size = 7): void {
  const rng = createRandom("shield:" + seed);
  const tinctures = ["#b23a32", "#2f5fa3", "#3d8a4a", "#3a3340", "#7a3f8f"], metals = ["#e9d48a", "#f1ede2"];
  const a = tinctures[rng.nextInt(0, tinctures.length - 1)], b = metals[rng.nextInt(0, 1)];
  const div = rng.nextInt(0, 3);
  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(x - size, y - size);
    ctx.lineTo(x + size, y - size);
    ctx.lineTo(x + size, y);
    ctx.bezierCurveTo(x + size, y + size * 0.7, x + size * 0.4, y + size * 1.1, x, y + size * 1.3);
    ctx.bezierCurveTo(x - size * 0.4, y + size * 1.1, x - size, y + size * 0.7, x - size, y);
    ctx.closePath();
  };
  ctx.save(); ctx.translate(SHX * 0.8, SHY * 0.8); shape(); ctx.fillStyle = "rgba(30,20,10,0.35)"; ctx.fill(); ctx.restore();
  shape(); ctx.fillStyle = a; ctx.fill();
  ctx.save(); shape(); ctx.clip();
  ctx.fillStyle = b;
  if (div === 0) ctx.fillRect(x, y - size * 1.2, size * 1.2, size * 3);
  else if (div === 1) ctx.fillRect(x - size * 1.2, y - size * 0.1, size * 2.4, size * 2);
  else if (div === 2) { ctx.beginPath(); ctx.moveTo(x - size, y - size); ctx.lineTo(x - size * 0.4, y - size); ctx.lineTo(x + size, y + size * 0.6); ctx.lineTo(x + size, y + size * 1.3); ctx.closePath(); ctx.fill(); }
  else { ctx.fillRect(x - size * 0.32, y - size * 1.2, size * 0.64, size * 3); ctx.fillRect(x - size * 1.2, y - size * 0.5, size * 2.4, size * 0.64); }
  ctx.restore();
  shape(); ctx.strokeStyle = "#3b2d1c"; ctx.lineWidth = 1; ctx.stroke();
}

export function drawMonastery(ctx: Ctx, x: number, y: number, r: number, seed: number): void {
  const rng = createRandom("abbey:" + seed);
  const a = rng.nextFloat() * 0.5 - 0.25;
  // Enclosure and garden.
  ctx.fillStyle = "#86a85a";
  ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
  ctx.strokeStyle = "#9c9686"; ctx.lineWidth = 1.6; ctx.setLineDash([5, 1.2]);
  ctx.beginPath(); ctx.arc(x, y, r - 1, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#6f9447";
  for (let i = 0; i < 4; i++) { const t = a + 0.9 + i * 0.5; ctx.beginPath(); ctx.arc(x + Math.cos(t) * r * 0.66, y + Math.sin(t) * r * 0.66, 1.5, 0, 6.2832); ctx.fill(); }
  ctx.save(); ctx.translate(x, y); ctx.rotate(a);
  const nave = (dx: number, dy: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.fillRect(-r * 0.62 + dx, -r * 0.2 + dy, r * 1.1, r * 0.42);
    ctx.fillRect(-r * 0.22 + dx, -r * 0.5 + dy, r * 0.38, r * 1.0);
  };
  nave(SHX, SHY, "rgba(35,30,25,0.3)");
  nave(0, 0, "#6c7f96");
  ctx.fillStyle = "#8da0b6";
  ctx.fillRect(-r * 0.62, -r * 0.2, r * 1.1, r * 0.21);
  ctx.fillRect(-r * 0.22, -r * 0.5, r * 0.19, r * 1.0);
  ctx.strokeStyle = "rgba(40,45,60,0.6)"; ctx.lineWidth = 0.6;
  ctx.strokeRect(-r * 0.62, -r * 0.2, r * 1.1, r * 0.42); ctx.strokeRect(-r * 0.22, -r * 0.5, r * 0.38, r * 1.0);
  // Bell tower at the west end.
  const bx = -r * 0.66, bs = r * 0.36;
  ctx.fillStyle = "rgba(35,30,25,0.3)"; ctx.fillRect(bx - bs / 2 + SHX, -bs / 2 + SHY, bs, bs);
  ctx.fillStyle = "#c9c1ae"; ctx.fillRect(bx - bs / 2, -bs / 2, bs, bs);
  ctx.fillStyle = "#a9523a";
  ctx.beginPath(); ctx.moveTo(bx - bs / 2, -bs / 2); ctx.lineTo(bx, 0); ctx.lineTo(bx - bs / 2, bs / 2); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#cd7654";
  ctx.beginPath(); ctx.moveTo(bx - bs / 2, -bs / 2); ctx.lineTo(bx, 0); ctx.lineTo(bx + bs / 2, -bs / 2); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "rgba(60,40,30,0.7)"; ctx.strokeRect(bx - bs / 2, -bs / 2, bs, bs);
  ctx.restore();
}

/** Player pawn: an original round-headed figure (standing, or lying for farmers). */
export function drawMeeple(ctx: Ctx, x: number, y: number, size: number, color: string, lying = false): void {
  ctx.save();
  ctx.translate(x, y);
  if (lying) ctx.rotate(-Math.PI / 2);
  const s = size / 20;
  const body = () => {
    ctx.beginPath();
    ctx.arc(0, -6.5 * s, 4.2 * s, 0, 6.2832);
    ctx.moveTo(-3 * s, -3.2 * s);
    ctx.bezierCurveTo(-9 * s, -2 * s, -9.5 * s, 3 * s, -7.5 * s, 9.5 * s);
    ctx.lineTo(7.5 * s, 9.5 * s);
    ctx.bezierCurveTo(9.5 * s, 3 * s, 9 * s, -2 * s, 3 * s, -3.2 * s);
    ctx.closePath();
  };
  ctx.save(); ctx.translate(1.4 * s, 2 * s); body(); ctx.fillStyle = "rgba(20,15,10,0.35)"; ctx.fill(); ctx.restore();
  body(); ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 1.5 * s; ctx.strokeStyle = "rgba(25,18,10,0.85)"; ctx.lineJoin = "round"; ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.32)";
  ctx.beginPath(); ctx.arc(-1.4 * s, -7.8 * s, 1.5 * s, 0, 6.2832); ctx.fill();
  ctx.restore();
}

export interface RenderOptions {
  /** Output size in pixels (64, 128, 256...). */
  px: number;
  /** Tile coordinates on the board (world-space textures) and rotation. */
  tx: number;
  ty: number;
  rotation: number;
  visualSeed: number;
  /** 0 = far (simplified), 1 = nominal, 2 = close. */
  detail?: number;
}

/** Paint a tile on a context whose origin is the tile's top-left corner. */
export function renderTile(ctx: Ctx, g: TileGeometry, o: RenderOptions): void {
  const px = o.px, scale = px / S, rot = o.rotation & 3, detail = o.detail ?? 1;
  const { kind } = g.mask;
  // 1. Ground: per-pixel world-space textures (continuous from tile to tile).
  const img = ctx.createImageData(px, px);
  const data = img.data;
  for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
    const x = (i + 0.5) / scale, y = (j + 0.5) / scale;
    let cx = x, cy = y;
    if (rot === 1) { cx = y; cy = S - x; } else if (rot === 2) { cx = S - x; cy = S - y; } else if (rot === 3) { cx = S - y; cy = x; }
    const k = kind[Math.min(S - 1, Math.floor(cy)) * S + Math.min(S - 1, Math.floor(cx))];
    const wx = o.tx * S + x, wy = o.ty * S + y;
    const c = k === K_CITY ? paveColor(wx, wy) : grassColor(wx, wy);
    // Fine grain, hashed per world pixel so that it never tiles visibly.
    const grain = ((hash2(Math.floor(wx * scale), Math.floor(wy * scale), 77) & 255) / 255 - 0.5) * 7;
    const p = (j * px + i) * 4;
    data[p] = c[0] + grain; data[p + 1] = c[1] + grain; data[p + 2] = c[2] + grain; data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  ctx.save();
  ctx.scale(scale, scale);
  ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.clip();
  const R = (p: Pt) => rotatePoint(p, rot);
  const decor = generateDecor(g, o.visualSeed, rot, o.tx, o.ty);
  const rng = createRandom("paint:" + g.topologyId + ":" + (o.visualSeed >>> 0));

  // 2. Crop patches.
  const CROPS = [["#d6c06a", "#c4ad58"], ["#b9c46a", "#a7b45b"], ["#c9a66b", "#b8945c"]];
  for (const c of decor.crops) {
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.a);
    ctx.fillStyle = CROPS[c.c][0]; ctx.globalAlpha = 0.85;
    ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.globalAlpha = 0.7; ctx.strokeStyle = CROPS[c.c][1]; ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let y = -c.h / 2 + 1.5; y < c.h / 2; y += 2.4) { ctx.moveTo(-c.w / 2, y); ctx.lineTo(c.w / 2, y); }
    ctx.stroke();
    ctx.globalAlpha = 0.5; ctx.strokeStyle = "#6f8a3c"; ctx.lineWidth = 1; ctx.strokeRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // 3. Roads: earth base, soft irregular verges, worn centre, wheel tracks.
  ctx.lineJoin = "round"; ctx.lineCap = "butt";
  const roads = g.shapes.roads.map((r) => r.path.map(R));
  for (const p of roads) { tracePath(ctx, p); ctx.strokeStyle = "rgba(86,74,44,0.55)"; ctx.lineWidth = 17.5; ctx.stroke(); }
  for (const p of roads) { tracePath(ctx, p); ctx.strokeStyle = "#c9ad7c"; ctx.lineWidth = 15; ctx.stroke(); }
  for (const p of roads) { tracePath(ctx, p); ctx.strokeStyle = "#d8c193"; ctx.lineWidth = 9; ctx.stroke(); }
  if (detail >= 1) {
    for (const p of roads) {
      ctx.strokeStyle = "rgba(128,104,68,0.45)"; ctx.lineWidth = 0.9;
      for (const off of [-3, 3]) {
        ctx.setLineDash([4 + rng.nextFloat() * 5, 3 + rng.nextFloat() * 4]);
        ctx.beginPath();
        for (let i = 0; i < p.length; i++) {
          const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
          const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const x = p[i].x - ((b.y - a.y) / l) * off, y = p[i].y + ((b.x - a.x) / l) * off;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(120,100,70,0.5)";
      for (let i = 2; i < p.length - 2; i += 3) if (rng.nextFloat() < 0.5) ctx.fillRect(p[i].x + (rng.nextFloat() - 0.5) * 9, p[i].y + (rng.nextFloat() - 0.5) * 9, 1, 1);
    }
  }
  // 4. Terminals.
  for (const t of g.shapes.terminals) {
    const p = R(t);
    ctx.fillStyle = "rgba(86,74,44,0.5)"; ctx.beginPath(); ctx.arc(p.x, p.y, t.r + 1.2, 0, 6.2832); ctx.fill();
    ctx.fillStyle = t.kind === "village" ? "#d2bd95" : "#cdb284"; ctx.beginPath(); ctx.arc(p.x, p.y, t.r, 0, 6.2832); ctx.fill();
    if (t.kind === "village") {
      ctx.fillStyle = "#8f8a7c"; ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, 6.2832); ctx.fill();
      ctx.fillStyle = "#4f6f8c"; ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, 6.2832); ctx.fill();
    } else {
      ctx.fillStyle = "#8a7a5a"; ctx.fillRect(p.x - 0.6, p.y - 2.6, 1.2, 5.2); ctx.fillRect(p.x - 2.6, p.y - 1.6, 5.2, 1.1); // signpost
    }
  }
  // 5. City lanes (decorative) then walls.
  if (detail >= 1) {
    ctx.strokeStyle = "rgba(150,128,92,0.35)"; ctx.lineWidth = 1.4;
    const hs = decor.houses;
    ctx.beginPath();
    for (let i = 0; i + 1 < hs.length; i += 2) { const a = hs[i], b = hs[i + 1]; if (Math.hypot(a.x - b.x, a.y - b.y) < 40) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); } }
    ctx.stroke();
  }
  for (const c of g.shapes.cities) for (const w of c.walls) drawWall(ctx, w.map(R));
  for (const gt of g.shapes.gates) {
    const p = R(gt), q = R({ x: gt.x + gt.nx, y: gt.y + gt.ny });
    const a = Math.atan2(q.y - p.y, q.x - p.x);
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(a);
    ctx.fillStyle = "#cdb284"; ctx.fillRect(-5, -5.5, 10, 11);
    ctx.fillStyle = "#3d342a"; ctx.fillRect(-2.2, -4, 4.4, 8);
    ctx.restore();
    drawTower(ctx, p.x - Math.sin(a) * 8.2, p.y + Math.cos(a) * 8.2, 4.6, true);
    drawTower(ctx, p.x + Math.sin(a) * 8.2, p.y - Math.cos(a) * 8.2, 4.6, true);
  }
  // 6. Small ground details.
  if (detail >= 1) {
    for (const b of decor.bushes) { ctx.fillStyle = "rgba(40,60,25,0.25)"; ctx.beginPath(); ctx.arc(b.x + 0.8, b.y + 1, b.r, 0, 6.2832); ctx.fill(); ctx.fillStyle = "#5d8a3a"; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.2832); ctx.fill(); }
    const FLOWERS = ["#f4e9a0", "#f2f0e6", "#e9a0a8"];
    for (const f of decor.flowers) { ctx.fillStyle = FLOWERS[f.c]; ctx.fillRect(f.x, f.y, 1.1, 1.1); ctx.fillRect(f.x + 2, f.y + 1.3, 1, 1); ctx.fillRect(f.x - 1.4, f.y + 2, 1, 1); }
    for (const r of decor.rocks) { ctx.fillStyle = "rgba(40,40,30,0.25)"; ctx.beginPath(); ctx.arc(r.x + 0.7, r.y + 0.9, r.r, 0, 6.2832); ctx.fill(); ctx.fillStyle = "#a7a294"; ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 6.2832); ctx.fill(); }
  }
  // 7. Standing objects, painted back to front.
  type Obj = { y: number; draw: () => void };
  const objs: Obj[] = [];
  for (const h of decor.houses) objs.push({ y: h.y, draw: () => drawHouse(ctx, h.x, h.y, h.w, h.h, h.a, h.roof, h.seed) });
  for (const t of decor.towers) objs.push({ y: t.y, draw: () => drawTower(ctx, t.x, t.y, t.r) });
  for (const t of decor.trees) objs.push({ y: t.y, draw: () => drawTree(ctx, t.x, t.y, t.r, t.conifer, t.tone) });
  for (const k of decor.keeps) objs.push({ y: k.y, draw: () => { drawTower(ctx, k.x, k.y, k.r, true); drawTower(ctx, k.x, k.y, k.r * 0.5); } });
  for (const s of decor.shields) objs.push({ y: s.y + 20, draw: () => drawShield(ctx, s.x, s.y - 1, s.seed, 6.5) });
  if (g.shapes.monastery) { const m = R(g.shapes.monastery); objs.push({ y: m.y, draw: () => drawMonastery(ctx, m.x, m.y, g.shapes.monastery!.r, o.visualSeed) }); }
  objs.sort((a, b) => a.y - b.y);
  for (const ob of objs) ob.draw();
  ctx.restore();
}

export type { House, Tree };
