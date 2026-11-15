/**
 * Live 3D board: every placed tile is a real three.js diorama (ground with relief textures,
 * houses, walls, towers, trees...) standing on a table, seen through a tilted perspective
 * camera. Same public surface as the 2D BoardView (camera, overlays, callbacks), so screens
 * can use either. It renders only when something changed and never mutates the game state.
 */
import * as THREE from "three";
import { TILE_SIZE } from "../core/types";
import type { TileDef } from "../core/types";
import { cellKey } from "../core/coordinates";
import { K_CITY, K_FIELD, K_MONASTERY, K_ROAD } from "../procedural/geometry/masks";
import { featureAt, generateGeometry, geometrySeedOf, rotatedAnchor, visualSeedOf } from "../procedural/geometry/tileGeometry";
import { getTopology } from "../procedural/topology/catalog";
import { generateDecor } from "../procedural/rendering/decor";
import { drawShield } from "../procedural/rendering/tileRenderer";
import type { RenderOptions } from "../procedural/rendering/tileRenderer";
import { Batches, SUN, addLights, buildBatches, buildProps, getKit, paintGround, setupRenderer } from "../procedural/rendering/tile3d";
import type { Batch } from "../procedural/rendering/tile3d";
import type { TileCache } from "../procedural/rendering/tileCache";
import type { GameState } from "../game/state";
import type { Ghost, Highlight, Spot } from "./boardRenderer";
import { PLAYER_COLORS } from "./dom";
import { BoardLife } from "./boardLife";

const S = TILE_SIZE;
/** Camera tilt from the vertical, and vertical field of view. */
const TILT = THREE.MathUtils.degToRad(38), FOV = 30;
/** Tile thickness: tiles are physical slabs lying on the table. */
const THICK = 3.2;
const TEX = 256;
/** Main-thread budget per frame for building new tiles. */
const BUDGET_MS = 10;

interface PointerPosition { x: number; y: number }
interface Popup { x: number; y: number; t0: number; sprite: THREE.Sprite }
interface TileRec { key: string; ground: THREE.Mesh; batches: Map<string, Batch>; shields: THREE.Object3D[] }

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = newCanvas(src.width, src.height);
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}
function canvasTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}
const tileKey = (def: TileDef, rotation: number, x: number, y: number) => `${def.topologyId}#${def.seed}@${rotation}:${x},${y}`;

/** Original round-headed pawn, extruded. Height ~16 world units, base at y = 0. */
function meepleGeometry(lying: boolean): THREE.BufferGeometry {
  const body = new THREE.Shape();
  body.moveTo(-3, 3.2);
  body.bezierCurveTo(-9, 2, -9.5, -3, -7.5, -9.5);
  body.lineTo(7.5, -9.5);
  body.bezierCurveTo(9.5, -3, 9, 2, 3, 3.2);
  body.closePath();
  const head = new THREE.Shape();
  head.absarc(0, 6.5, 4.2, 0, Math.PI * 2, false);
  const g = new THREE.ExtrudeGeometry([body, head], { depth: 3.6, bevelEnabled: true, bevelSize: 0.9, bevelThickness: 0.9, bevelSegments: 2, curveSegments: 10 });
  g.translate(0, 9.5 + 0.9, -1.8);
  g.scale(0.78, 0.78, 0.78);
  if (lying) { g.rotateX(-Math.PI / 2); g.computeBoundingBox(); g.translate(0, -g.boundingBox!.min.y, 0); }
  return g;
}

function spotTexture(fill: string | null): THREE.CanvasTexture {
  const c = newCanvas(96, 96), x = c.getContext("2d")!;
  x.beginPath(); x.arc(48, 48, 40, 0, Math.PI * 2);
  if (fill) {
    x.fillStyle = "rgba(255,250,225,0.95)"; x.fill();
    x.lineWidth = 6; x.strokeStyle = "#4a3a22"; x.stroke();
    x.fillStyle = fill; x.beginPath(); x.arc(48, 48, 20, 0, Math.PI * 2); x.fill();
  } else {
    x.fillStyle = "rgba(90,80,70,0.7)"; x.fill();
    x.lineWidth = 6; x.strokeStyle = "rgba(40,30,20,0.9)"; x.stroke();
    x.beginPath(); x.moveTo(24, 24); x.lineTo(72, 72); x.stroke();
  }
  return canvasTexture(c);
}

export class BoardView3D {
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
  stats = { frameMs: 0, drawn: 0, generated: 0, frames: 0 };

  private state: GameState | null = null;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(FOV, 1, 1, 10000);
  private sun: THREE.DirectionalLight;
  private kit = getKit(false);
  private tiles = new Map<string, TileRec>();
  private props = new THREE.Group();
  private bases: THREE.InstancedMesh | null = null;
  private propsDirty = false;
  private overlays = new THREE.Group();
  private meeples = new THREE.Group();
  private ghostGroup: THREE.Group | null = null;
  private ghostKey = "";
  private hlGroup = new THREE.Group();
  private popups: Popup[] = [];
  private dirty = true;
  /** Hard frames rebuild the scene and shadows; ambient frames only animate (~30 fps). */
  private hard = true;
  private lastFrame = 0;
  private life = new BoardLife();
  private raf = 0;
  private ro: ResizeObserver;
  private drag: { x: number; y: number; wx: number; wy: number; moved: boolean; id: number } | null = null;
  private touches = new Map<number, PointerPosition>();
  private disposed = false;
  private ray = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private shared: {
    tileGeo: THREE.PlaneGeometry; baseGeo: THREE.BoxGeometry; baseMat: THREE.MeshStandardMaterial;
    legalMat: THREE.MeshBasicMaterial; lastMat: THREE.MeshBasicMaterial; ghostOk: THREE.MeshBasicMaterial; ghostBad: THREE.MeshBasicMaterial;
    standing: THREE.BufferGeometry; lying: THREE.BufferGeometry; meepleMats: Map<string, THREE.MeshStandardMaterial>;
    spotMats: Map<string, THREE.SpriteMaterial>; shieldTex: Map<number, THREE.CanvasTexture>; textures: THREE.Texture[];
  };

  constructor(readonly canvas: HTMLCanvasElement, readonly cache: TileCache) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    setupRenderer(this.renderer);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const max = this.renderer.capabilities.maxTextureSize;
    const scene = this.scene;
    scene.background = new THREE.Color("#ded0ae");
    scene.fog = new THREE.Fog("#ded0ae", 4000, 9000);
    this.sun = addLights(scene).sun;
    this.sun.shadow.mapSize.set(Math.min(4096, max), Math.min(4096, max));
    scene.add(this.sun.target, this.props, this.overlays, this.meeples, this.hlGroup, this.life.root);
    this.renderer.shadowMap.autoUpdate = false;

    // The table: parchment with a faint cell grid (the board's coordinate system).
    const tc = newCanvas(256, 256), tx = tc.getContext("2d")!;
    tx.fillStyle = "#e3d5b3"; tx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) { const v = (i * 2654435761) >>> 0; tx.fillStyle = `rgba(120,95,60,${0.03 + (v & 7) / 200})`; tx.fillRect(v & 255, (v >>> 8) & 255, 2, 2); }
    tx.strokeStyle = "rgba(120,95,60,0.22)"; tx.lineWidth = 2; tx.strokeRect(1, 1, 254, 254);
    const tableTex = canvasTexture(tc);
    tableTex.wrapS = tableTex.wrapT = THREE.RepeatWrapping;
    const span = 600;
    tableTex.repeat.set(span, span);
    const table = new THREE.Mesh(new THREE.PlaneGeometry(span * S, span * S), new THREE.MeshStandardMaterial({ map: tableTex, roughness: 1 }));
    table.rotation.x = -Math.PI / 2;
    table.position.y = -THICK;
    table.receiveShadow = true;
    scene.add(table);

    const frame = (fill: string, stroke: string, dash: boolean, width: number) => {
      const c = newCanvas(128, 128), x = c.getContext("2d")!;
      x.fillStyle = fill; x.fillRect(6, 6, 116, 116);
      x.strokeStyle = stroke; x.lineWidth = width;
      if (dash) x.setLineDash([12, 9]);
      x.strokeRect(6 + width / 2, 6 + width / 2, 116 - width, 116 - width);
      return canvasTexture(c);
    };
    const overlayMat = (map: THREE.Texture) => new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 });
    const tileGeo = new THREE.PlaneGeometry(S, S).rotateX(-Math.PI / 2);
    const baseGeo = new THREE.BoxGeometry(S - 0.6, THICK, S - 0.6).translate(0, -THICK / 2 - 0.05, 0);
    const textures: THREE.Texture[] = [tableTex];
    const mk = (t: THREE.CanvasTexture) => { textures.push(t); return overlayMat(t); };
    this.shared = {
      tileGeo, baseGeo,
      baseMat: new THREE.MeshStandardMaterial({ color: "#c9b38a", roughness: 0.95 }),
      legalMat: mk(frame("rgba(96,140,70,0.22)", "rgba(62,104,44,0.9)", true, 5)),
      lastMat: mk(frame("rgba(0,0,0,0)", "rgba(255,246,214,0.95)", false, 5)),
      ghostOk: mk(frame("rgba(0,0,0,0)", "#f7e9a8", false, 7)),
      ghostBad: mk(frame("rgba(192,57,43,0.3)", "#c0392b", false, 7)),
      standing: meepleGeometry(false), lying: meepleGeometry(true),
      meepleMats: new Map(), spotMats: new Map(), shieldTex: new Map(), textures,
    };

    this.ro = new ResizeObserver(() => this.requestRender());
    this.ro.observe(canvas);
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onCancel);
    canvas.addEventListener("lostpointercapture", this.onCancel);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); this.onRotate?.(); });
    canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
    document.addEventListener("visibilitychange", this.onVisible);
    this.requestRender();
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    document.removeEventListener("visibilitychange", this.onVisible);
    this.life.dispose();
    for (const r of this.tiles.values()) this.disposeTile(r);
    this.tiles.clear();
    this.clearGroup(this.props); this.clearGroup(this.overlays); this.clearGroup(this.meeples); this.clearGroup(this.hlGroup);
    if (this.ghostGroup) this.disposeGroup(this.ghostGroup);
    for (const t of this.shared.textures) t.dispose();
    for (const t of this.shared.shieldTex.values()) t.dispose();
    this.renderer.dispose();
  }

  setState(state: GameState | null): void { this.state = state; this.requestRender(); }
  getState(): GameState | null { return this.state; }
  setHighlight(hl: Highlight | null): void { this.highlight = hl; this.hlDirty = true; this.requestRender(); }
  private hlDirty = false;

  requestRender(): void {
    this.dirty = true;
    this.hard = true;
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.frame);
  }
  private ambient(): void {
    this.dirty = true;
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.frame);
  }
  private onVisible = (): void => { if (!document.hidden) this.requestRender(); };

  addPopup(tx: number, ty: number, text: string, color: string): void {
    const c = newCanvas(256, 96), x = c.getContext("2d")!;
    x.font = 'bold 64px Georgia, "Times New Roman", serif'; x.textAlign = "center"; x.textBaseline = "middle";
    x.lineWidth = 10; x.strokeStyle = "rgba(40,28,14,0.85)"; x.strokeText(text, 128, 50);
    x.fillStyle = color; x.fillText(text, 128, 50);
    const tex = canvasTexture(c);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
    sprite.renderOrder = 20;
    this.scene.add(sprite);
    this.popups.push({ x: (tx + 0.5) * S, y: (ty + 0.5) * S, t0: performance.now(), sprite });
    this.requestRender();
  }

  centerOn(tx: number, ty: number, animate = true): void {
    const target = { x: (tx + 0.5) * S, y: (ty + 0.5) * S };
    if (!animate) { this.camera.x = target.x; this.camera.y = target.y; this.requestRender(); return; }
    const from = { ...this.camera }, t0 = performance.now();
    const step = () => {
      if (this.disposed) return;
      const k = Math.min(1, (performance.now() - t0) / 320), e = 1 - Math.pow(1 - k, 3);
      this.camera.x = from.x + (target.x - from.x) * e; this.camera.y = from.y + (target.y - from.y) * e;
      this.requestRender();
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  fit(): void {
    const s = this.state;
    if (!s || !s.tiles.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of s.tiles) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x); y1 = Math.max(y1, t.y); }
    const w = this.canvas.clientWidth || 800, hgt = this.canvas.clientHeight || 600;
    this.camera.x = ((x0 + x1 + 1) / 2) * S; this.camera.y = ((y0 + y1 + 1) / 2) * S;
    this.camera.zoom = Math.max(0.08, Math.min(1.5, Math.min(w / ((x1 - x0 + 2.4) * S), hgt / ((y1 - y0 + 2.4) * S * Math.cos(TILT)))));
    this.requestRender();
  }

  isOffCentre(tx: number, ty: number): boolean {
    this.updateCamera();
    const p = new THREE.Vector3((tx + 0.5) * S, 0, (ty + 0.5) * S).project(this.cam);
    return Math.abs(p.x) > 0.72 || Math.abs(p.y) > 0.72;
  }

  screenToWorld(px: number, py: number): { x: number; y: number } {
    this.updateCamera();
    const w = this.canvas.clientWidth || 1, hgt = this.canvas.clientHeight || 1;
    this.ray.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, -(py / hgt) * 2 + 1), this.cam);
    const hit = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.ground, hit)) return { x: this.camera.x, y: this.camera.y };
    return { x: hit.x, y: hit.z };
  }
  private worldToScreen(x: number, h: number, y: number): { x: number; y: number } {
    const p = new THREE.Vector3(x, h, y).project(this.cam);
    return { x: (p.x + 1) / 2 * this.canvas.clientWidth, y: (1 - p.y) / 2 * this.canvas.clientHeight };
  }

  // ------------------------------------------------------------------ input
  private pointerPosition(e: MouseEvent): PointerPosition {
    const b = this.canvas.getBoundingClientRect();
    switch (this.quarterTurns) {
      case 1: return { x: e.clientY - b.top, y: b.right - e.clientX };
      case 2: return { x: b.right - e.clientX, y: b.bottom - e.clientY };
      case 3: return { x: b.bottom - e.clientY, y: e.clientX - b.left };
      default: return { x: e.clientX - b.left, y: e.clientY - b.top };
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
    const w = this.screenToWorld(point.x, point.y);
    this.drag = { ...point, wx: w.x, wy: w.y, moved: false, id: e.pointerId };
  };
  private onMove = (e: PointerEvent): void => {
    const point = this.pointerPosition(e);
    if (this.touches.has(e.pointerId)) {
      const before = this.pinchGeometry();
      this.touches.set(e.pointerId, point);
      const after = this.pinchGeometry();
      if (before && after) {
        this.zoomAt(before.distance > 0 && after.distance > 0 ? after.distance / before.distance : 1, before, after);
        return;
      }
    }
    if (this.drag) {
      if (this.drag.id !== e.pointerId) return;
      if (!this.drag.moved && Math.hypot(point.x - this.drag.x, point.y - this.drag.y) < 5) return;
      this.drag.moved = true;
      // Keep the grabbed ground point under the pointer.
      const w = this.screenToWorld(point.x, point.y);
      this.camera.x += this.drag.wx - w.x; this.camera.y += this.drag.wy - w.y;
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
      const w = this.screenToWorld(point.x, point.y);
      this.drag = { ...point, wx: w.x, wy: w.y, moved: true, id };
    }
    if (this.drag?.id === e.pointerId) { this.drag = null; this.canvas.style.cursor = ""; }
  };
  private onUp = (e: PointerEvent): void => {
    const d = this.drag?.id === e.pointerId ? this.drag : null;
    this.onCancel(e);
    if (!d || d.moved || !this.interactive) return;
    const point = this.pointerPosition(e);
    // Meeple spots are hit-tested on screen, where they are drawn.
    let best: Spot | null = null, bestD = Math.max(16, this.spotPx() * 0.6);
    for (const s of this.spots) {
      const p = this.worldToScreen(s.x, 6, s.y), dist = Math.hypot(p.x - point.x, p.y - point.y);
      if (dist < bestD) { best = s; bestD = dist; }
    }
    if (best) { this.onSpotClick?.(best); return; }
    const w = this.screenToWorld(point.x, point.y);
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

  // ------------------------------------------------------------------ scene upkeep
  /** Camera distance so that `zoom` pixels map to one world unit at the look-at point. */
  private updateCamera(): void {
    const w = this.canvas.clientWidth || 800, hgt = this.canvas.clientHeight || 600;
    const d = hgt / (2 * this.camera.zoom * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    const c = this.cam;
    c.aspect = w / hgt;
    c.near = Math.max(1, d * 0.2); c.far = d * 6;
    c.position.set(this.camera.x, d * Math.cos(TILT), this.camera.y + d * Math.sin(TILT));
    c.lookAt(this.camera.x, 0, this.camera.y);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    if (this.scene.fog instanceof THREE.Fog) { this.scene.fog.near = d * 1.4; this.scene.fog.far = d * 3.2; }
  }

  private spotPx(): number { return Math.max(22, 22 * this.camera.zoom); }

  private buildTile(def: TileDef, rotation: number, x: number, y: number): TileRec {
    const g = generateGeometry(def.topologyId, geometrySeedOf(def.seed));
    const o: RenderOptions = { px: TEX, tx: x, ty: y, rotation, visualSeed: visualSeedOf(def.seed), detail: 2 };
    const decor = generateDecor(g, o.visualSeed, rotation & 3, x, y);
    const surf = paintGround(TEX, g, o, decor);
    const map = canvasTexture(cloneCanvas(surf.albedo));
    const normalMap = canvasTexture(cloneCanvas(surf.normal), false);
    const ground = new THREE.Mesh(this.shared.tileGeo, new THREE.MeshStandardMaterial({ map, normalMap, roughness: 0.94, metalness: 0 }));
    ground.position.set(x * S + S / 2, 0, y * S + S / 2);
    ground.receiveShadow = true;
    const B = new Batches();
    B.ox = x * S; B.oz = y * S;
    buildProps(B, g, o, decor);
    // City shields stand as painted boards on a post, facing the player.
    const shields: THREE.Object3D[] = [];
    for (const sh of decor.shields) {
      let tex = this.shared.shieldTex.get(sh.seed);
      if (!tex) {
        const c = newCanvas(64, 64), cx = c.getContext("2d")!;
        cx.scale(64 / 18, 64 / 18);
        drawShield(cx, 9, 6.5, sh.seed, 7);
        tex = canvasTexture(c);
        this.shared.shieldTex.set(sh.seed, tex);
      }
      const board = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.4, roughness: 0.6, side: THREE.DoubleSide }));
      board.position.set(x * S + sh.x, 9.5, y * S + sh.y);
      board.rotation.x = -0.35;
      board.castShadow = true;
      B.add("box", "plain", "#5d4630", sh.x, 0, sh.y - 0.6, 0.7, 7, 0.7);
      shields.push(board);
      this.scene.add(board);
    }
    this.scene.add(ground);
    return { key: tileKey(def, rotation, x, y), ground, batches: B.map, shields };
  }

  private disposeTile(r: TileRec): void {
    const m = r.ground.material as THREE.MeshStandardMaterial;
    m.map?.dispose(); m.normalMap?.dispose(); m.dispose();
    r.ground.removeFromParent();
    for (const s of r.shields) { s.removeFromParent(); ((s as THREE.Mesh).material as THREE.Material).dispose(); (s as THREE.Mesh).geometry.dispose(); }
  }
  private clearGroup(g: THREE.Object3D): void {
    for (const c of [...g.children]) {
      c.removeFromParent();
      if (c instanceof THREE.InstancedMesh) c.dispose();
    }
  }
  private disposeGroup(g: THREE.Object3D): void {
    g.removeFromParent();
    g.traverse((c) => {
      if (c instanceof THREE.InstancedMesh) c.dispose();
      else if (c instanceof THREE.Mesh && c.userData.own) { const m = c.material as THREE.MeshStandardMaterial; m.map?.dispose(); m.normalMap?.dispose(); m.dispose(); }
    });
  }

  /** Add / remove tile dioramas to match the state, within a per-frame budget. */
  private syncTiles(start: number): boolean {
    const st = this.state;
    const want = new Map<string, { def: TileDef; rotation: number; x: number; y: number }>();
    if (st) for (const t of st.tiles) want.set(tileKey(t.def, t.rotation, t.x, t.y), t);
    for (const [k, r] of this.tiles) if (!want.has(k)) { this.disposeTile(r); this.tiles.delete(k); this.propsDirty = true; }
    // Nearest tiles to the view first.
    const missing = [...want].filter(([k]) => !this.tiles.has(k));
    missing.sort((a, b) => Math.hypot(a[1].x * S - this.camera.x, a[1].y * S - this.camera.y) - Math.hypot(b[1].x * S - this.camera.x, b[1].y * S - this.camera.y));
    let built = 0;
    for (const [k, t] of missing) {
      if (built > 0 && performance.now() - start > BUDGET_MS) break;
      this.tiles.set(k, this.buildTile(t.def, t.rotation, t.x, t.y));
      built++;
      this.propsDirty = true;
    }
    this.stats.generated = built;
    if (this.propsDirty) {
      this.propsDirty = false;
      this.clearGroup(this.props);
      const merged = new Map<string, Batch>();
      for (const r of this.tiles.values()) for (const [key, b] of r.batches) {
        let m = merged.get(key);
        if (!m) { m = { geo: b.geo, mat: b.mat, m: [], c: [] }; merged.set(key, m); }
        m.m.push(...b.m); m.c.push(...b.c);
      }
      buildBatches(merged.values(), this.kit, this.props);
      // Tile slabs (one instanced draw).
      if (this.bases) { this.bases.removeFromParent(); this.bases.dispose(); }
      const recs = [...this.tiles.values()];
      this.bases = new THREE.InstancedMesh(this.shared.baseGeo, this.shared.baseMat, Math.max(1, recs.length));
      this.bases.count = recs.length;
      const mtx = new THREE.Matrix4();
      recs.forEach((r, i) => this.bases!.setMatrixAt(i, mtx.makeTranslation(r.ground.position.x, 0, r.ground.position.z)));
      this.bases.castShadow = true; this.bases.receiveShadow = true; this.bases.frustumCulled = false;
      this.scene.add(this.bases);
    }
    this.stats.drawn = this.tiles.size;
    return missing.length > built;
  }

  private syncGhost(): void {
    const g = this.ghost;
    const key = g ? tileKey(g.def, g.rotation, g.x, g.y) + (g.legal ? "+" : "-") : "";
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    if (this.ghostGroup) { this.disposeGroup(this.ghostGroup); this.ghostGroup = null; }
    if (!g) return;
    const group = new THREE.Group();
    const geo = generateGeometry(g.def.topologyId, geometrySeedOf(g.def.seed));
    const o: RenderOptions = { px: TEX, tx: g.x, ty: g.y, rotation: g.rotation, visualSeed: visualSeedOf(g.def.seed), detail: 2 };
    const decor = generateDecor(geo, o.visualSeed, g.rotation & 3, g.x, g.y);
    const surf = paintGround(TEX, geo, o, decor);
    const ground = new THREE.Mesh(this.shared.tileGeo, new THREE.MeshStandardMaterial({ map: canvasTexture(cloneCanvas(surf.albedo)), normalMap: canvasTexture(cloneCanvas(surf.normal), false), roughness: 0.94 }));
    ground.userData.own = true;
    ground.position.set(g.x * S + S / 2, 0, g.y * S + S / 2);
    ground.receiveShadow = true;
    const slab = new THREE.Mesh(this.shared.baseGeo, this.shared.baseMat);
    slab.position.copy(ground.position);
    slab.castShadow = true;
    const B = new Batches();
    B.ox = g.x * S; B.oz = g.y * S;
    buildProps(B, geo, o, decor);
    buildBatches(B.map.values(), this.kit, group);
    const frame = new THREE.Mesh(this.shared.tileGeo, g.legal ? this.shared.ghostOk : this.shared.ghostBad);
    frame.position.set(ground.position.x, 0.3, ground.position.z);
    frame.renderOrder = 5;
    group.add(ground, slab, frame);
    // Held a little above the table, as if about to be laid down.
    group.position.y = g.legal ? 5 : 9;
    this.ghostGroup = group;
    this.scene.add(group);
  }

  private syncHighlight(): void {
    if (!this.hlDirty) return;
    this.hlDirty = false;
    for (const c of [...this.hlGroup.children]) { c.removeFromParent(); const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial; m.map?.dispose(); m.dispose(); }
    const hl = this.highlight, st = this.state;
    if (!hl || !st) return;
    const rgb = [parseInt(hl.color.slice(1, 3), 16), parseInt(hl.color.slice(3, 5), 16), parseInt(hl.color.slice(5, 7), 16)];
    for (const [ti, features] of hl.features) {
      const t = st.tiles[ti];
      if (!t) continue;
      const g = generateGeometry(t.def.topologyId, geometrySeedOf(t.def.seed));
      const topo = getTopology(t.def.topologyId);
      const c = newCanvas(S, S), x = c.getContext("2d")!, img = x.createImageData(S, S);
      const nc = topo.cities.length, nr = topo.roads.length, nf = topo.fields.length, r = t.rotation & 3;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        let cx = i, cy = j;
        if (r === 1) { cx = j; cy = S - 1 - i; } else if (r === 2) { cx = S - 1 - i; cy = S - 1 - j; } else if (r === 3) { cx = S - 1 - j; cy = i; }
        const k = cy * S + cx, kd = g.mask.kind[k], id = g.mask.id[k];
        const f = kd === K_CITY ? id : kd === K_ROAD ? nc + id : kd === K_FIELD ? nc + nr + id : kd === K_MONASTERY ? nc + nr + nf : -1;
        if (!features.has(f)) continue;
        const p = (j * S + i) * 4;
        img.data[p] = rgb[0]; img.data[p + 1] = rgb[1]; img.data[p + 2] = rgb[2]; img.data[p + 3] = 150;
      }
      x.putImageData(img, 0, 0);
      const mesh = new THREE.Mesh(this.shared.tileGeo, new THREE.MeshBasicMaterial({ map: canvasTexture(c), transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      mesh.position.set(t.x * S + S / 2, 0.5, t.y * S + S / 2);
      mesh.renderOrder = 6;
      this.hlGroup.add(mesh);
    }
  }

  private syncOverlays(): void {
    this.clearGroup(this.overlays);
    for (const m of [...this.meeples.children]) m.removeFromParent();
    const st = this.state, sh = this.shared;
    if (!st) return;
    const plane = (mat: THREE.Material, x: number, y: number, h: number, order: number) => {
      const m = new THREE.Mesh(sh.tileGeo, mat);
      m.position.set(x * S + S / 2, h, y * S + S / 2);
      m.renderOrder = order;
      this.overlays.add(m);
    };
    if (this.lastTile >= 0 && st.tiles[this.lastTile]) { const t = st.tiles[this.lastTile]; plane(sh.lastMat, t.x, t.y, 0.2, 4); }
    if (this.showLegal) for (const c of this.legalCells) {
      if (this.ghost && this.ghost.x === c.x && this.ghost.y === c.y) continue;
      plane(sh.legalMat, c.x, c.y, -THICK + 0.15, 3);
    }
    // Meeples stand on their anchors (farmers lie down in their field); never under ~22 px tall.
    const meepleScale = Math.max(1.3, 22 / (this.camera.zoom * 16));
    for (const region of st.regions.values()) for (const mp of region.meeples) {
      const t = st.tiles[mp.tile];
      const a = rotatedAnchor(generateGeometry(t.def.topologyId, geometrySeedOf(t.def.seed)), t.rotation, mp.feature);
      const color = PLAYER_COLORS[st.config.players[mp.player].color];
      let mat = sh.meepleMats.get(color);
      if (!mat) { mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0 }); sh.meepleMats.set(color, mat); }
      const m = new THREE.Mesh(region.kind === "field" ? sh.lying : sh.standing, mat);
      m.position.set(t.x * S + a.x, 0, t.y * S + a.y);
      m.scale.setScalar(meepleScale);
      m.castShadow = true; m.receiveShadow = true;
      this.meeples.add(m);
    }
    // Meeple spots: crisp markers that always face the camera.
    const size = this.spotPx() / this.camera.zoom;
    for (const s of this.spots) {
      const glyph = s.option.allowed ? ({ city: "#b4553a", road: "#b59a68", field: "#6f9c44", monastery: "#6c7f96" } as Record<string, string>)[s.option.kind] : "";
      let mat = sh.spotMats.get(glyph);
      if (!mat) {
        const tex = spotTexture(glyph || null);
        sh.textures.push(tex);
        mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false });
        sh.spotMats.set(glyph, mat);
      }
      const sp = new THREE.Sprite(mat);
      sp.position.set(s.x, 6, s.y);
      sp.scale.set(size, size, 1);
      sp.renderOrder = 10;
      this.overlays.add(sp);
    }
  }

  private frame = (): void => {
    this.raf = 0;
    if (!this.dirty || this.disposed) return;
    const t0 = performance.now();
    if (!this.hard && t0 - this.lastFrame < 31) { this.raf = requestAnimationFrame(this.frame); return; }
    const hard = this.hard;
    this.dirty = false; this.hard = false; this.lastFrame = t0;
    const again = this.render(t0, hard);
    this.stats.frameMs = performance.now() - t0;
    this.stats.frames++;
    if (again) this.requestRender();
    else if (this.life.animating && !document.hidden) this.ambient();
  };

  private render(now: number, hard: boolean): boolean {
    const w = this.canvas.clientWidth, hgt = this.canvas.clientHeight;
    if (!w || !hgt) return false;
    const r = this.renderer;
    const size = r.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== hgt) r.setSize(w, hgt, false);
    this.updateCamera();
    let again = false;
    if (hard) {
      again = this.syncTiles(now);
      this.syncGhost();
      this.syncHighlight();
      this.syncOverlays();
      this.life.sync(this.state, now);
    }
    this.life.update(now, (hgt * r.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2))), this.camera.zoom);
    r.shadowMap.needsUpdate = hard || this.life.raising(now);

    // Shadows follow the view: the shadow frustum covers what is on screen.
    const reach = Math.min(1800, (Math.max(w, hgt) / this.camera.zoom) * 0.75 + 60);
    const target = new THREE.Vector3(this.camera.x, 0, this.camera.y);
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(SUN, reach * 2);
    const sc = this.sun.shadow.camera;
    sc.left = -reach; sc.right = reach; sc.top = reach; sc.bottom = -reach; sc.near = 1; sc.far = reach * 4;
    sc.updateProjectionMatrix();

    // Score pop-ups rise and fade.
    if (this.popups.length) {
      const k0 = this.camera.zoom;
      this.popups = this.popups.filter((p) => {
        const k = (now - p.t0) / 2200;
        if (k >= 1) { p.sprite.removeFromParent(); p.sprite.material.map?.dispose(); p.sprite.material.dispose(); return false; }
        const px = Math.max(26, 34 * Math.min(1.4, k0 + 0.4)) / k0;
        p.sprite.scale.set(px * 2.6, px, 1);
        p.sprite.position.set(p.x, 18 + k * 60 / k0, p.y);
        p.sprite.material.opacity = k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25;
        return true;
      });
      again = again || this.popups.length > 0;
    }
    r.render(this.scene, this.cam);
    return again;
  }
}
