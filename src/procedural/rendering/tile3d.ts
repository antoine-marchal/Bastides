/**
 * Three.js diorama renderer for tiles. Each tile is modelled as a small 3D scene (ground
 * with normal-mapped grass / cobbles / ruts, houses with gabled roofs, round towers,
 * crenellated walls, trees, monastery...) lit by a low western sun with soft shadows, and
 * rendered with an oblique projection, as if seen slightly from the south.
 *
 * The GROUND maps exactly onto the output square: tile seams, meeple anchors and picking
 * stay identical to the 2D renderer; only standing objects rise "up" on screen.
 *
 * Like the 2D renderer this only DRESSES the geometry and never feeds anything back into
 * the rules. When WebGL is unavailable (tests, old WebViews, lost context) it returns
 * false and the caller falls back to the Canvas 2D painter.
 */
import * as THREE from "three";
import { TILE_SIZE } from "../../core/types";
import type { Pt } from "../../core/types";
import { rotatePoint } from "../../core/coordinates";
import { hash2 } from "../../core/hash";
import { createRandom } from "../../core/random";
import { K_CITY } from "../geometry/masks";
import type { TileGeometry } from "../geometry/tileGeometry";
import { generateDecor } from "./decor";
import type { Decor } from "./decor";
import { fbm, valueNoise } from "./noise";
import { drawShield, grassColor } from "./tileRenderer";
import type { Ctx, RenderOptions } from "./tileRenderer";

const S = TILE_SIZE;
/** Oblique factor: a point at height h appears h*K units further north on screen... */
const K = 0.6;
/** ...fading to a straight top-down view within LEAN_BAND of the north and south edges, so
 * that walls and trees crossing a seam line up exactly with the neighbouring tile. */
const LEAN_BAND = 18;

/**
 * Oblique projection as a vertex-shader shear. Shading and shadows are computed on the
 * true 3D shape; only the on-screen position is sheared, and the depth follows the oblique
 * view ray so that southern objects correctly hide the ones they lean over.
 */
function lean<M extends THREE.Material>(mat: M): M {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <project_vertex>", `
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      vec4 leanWp = modelMatrix * mvPosition;
      float leanZ = leanWp.z;
      float leanF = ${K.toFixed(3)} * clamp( min( leanZ, ${S.toFixed(1)} - leanZ ) / ${LEAN_BAND.toFixed(1)}, 0.0, 1.0 );
      leanWp.z -= max( leanWp.y, 0.0 ) * leanF;
      mvPosition = viewMatrix * leanWp;
      gl_Position = projectionMatrix * mvPosition;
      float leanDepth = leanWp.y + ${K.toFixed(3)} * leanZ;
      gl_Position.z = 1.0 - 2.0 * ( leanDepth + 20.0 ) / 180.0;
    `);
  };
  mat.customProgramCacheKey = () => "lean";
  return mat;
}
/** High sun from the west, a little south of west: short shadows falling east-north-east. */
export const SUN = new THREE.Vector3(-0.56, 1, 0.24).normalize();

const ROOFS = ["#c8613f", "#d47148", "#bb563b", "#a86651"];
const PLASTER = ["#f1e7cf", "#e6d5b2", "#dcc7a0", "#efe0c4", "#d9cdb5"];
const SLATE = "#6b7f99", TERRACOTTA = "#c2623f", STONE = "#b3ac9b", STONE_DARK = "#958e7e";

// ---------------------------------------------------------------- shared GPU resources

interface Rig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  sun: THREE.DirectionalLight;
  ground: THREE.Mesh;
  groundMat: THREE.MeshStandardMaterial;
  objects: THREE.Group;
  size: number;
}
let rig: Rig | null | undefined;
const surfaces = new Map<number, { albedo: HTMLCanvasElement; normal: HTMLCanvasElement; relief: HTMLCanvasElement; albedoTex: THREE.CanvasTexture; normalTex: THREE.CanvasTexture }>();

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

function getRig(): Rig | null {
  if (rig !== undefined) {
    if (rig && rig.renderer.getContext().isContextLost()) return null;
    return rig;
  }
  rig = null;
  if (typeof document === "undefined") return null;
  try {
    const renderer = new THREE.WebGLRenderer({ canvas: canvas(128, 128), antialias: true, preserveDrawingBuffer: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(1);
    setupRenderer(renderer);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#93b05c");
    // Straight-down orthographic camera; the oblique "lean" is applied in the vertex shader.
    const camera = new THREE.OrthographicCamera(-S / 2, S / 2, S / 2, -S / 2, 1, 600);
    camera.position.set(S / 2, 300, S / 2);
    camera.up.set(0, 0, -1);
    camera.lookAt(S / 2, 0, S / 2);
    camera.updateMatrixWorld();

    const { sun } = addLights(scene);
    sun.position.set(S / 2, 0, S / 2).addScaledVector(SUN, 200);
    sun.target.position.set(S / 2, 0, S / 2);
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -82; sc.right = 82; sc.top = 82; sc.bottom = -82; sc.near = 60; sc.far = 340;
    scene.add(sun.target);

    const groundMat = lean(new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0 }));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(S, S), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(S / 2, 0, S / 2);
    ground.receiveShadow = true;
    scene.add(ground);

    const objects = new THREE.Group();
    scene.add(objects);
    rig = { renderer, scene, camera, sun, ground, groundMat, objects, size: 128 };
  } catch {
    rig = null;
  }
  return rig;
}

/** Renderer colour pipeline and the light rig shared by baked tiles and the live board. */
export function setupRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.04;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}
export function addLights(scene: THREE.Scene): { sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight } {
  const hemi = new THREE.HemisphereLight("#e4ecff", "#7d7350", 1.45);
  const sun = new THREE.DirectionalLight("#fff0d4", 2.35);
  sun.castShadow = true;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.25;
  sun.shadow.radius = 3;
  scene.add(hemi, sun);
  return { sun, hemi };
}

function surface(t: number) {
  let s = surfaces.get(t);
  if (s) return s;
  const albedo = canvas(t, t), normal = canvas(t, t), relief = canvas(t, t);
  const albedoTex = new THREE.CanvasTexture(albedo);
  albedoTex.colorSpace = THREE.SRGBColorSpace;
  albedoTex.anisotropy = 4;
  const normalTex = new THREE.CanvasTexture(normal);
  normalTex.colorSpace = THREE.NoColorSpace;
  s = { albedo, normal, relief, albedoTex, normalTex };
  surfaces.set(t, s);
  return s;
}

// ---------------------------------------------------------------- unit geometries & materials

function baseAt0(g: THREE.BufferGeometry): THREE.BufferGeometry { g.translate(0, 0.5, 0); return g; }

/** Gable roof prism: footprint [-.5,.5]^2 at y=0, ridge along X at y=1. */
function gableGeometry(): THREE.BufferGeometry {
  const p = [
    // south slope (z+)
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,
    // north slope (z-)
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,
    // gable ends
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
    0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0,
  ];
  const uv = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0.5, 0.5, 0, 0, 1, 0, 0.5, 0.5];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function proceduralTexture(w: number, h: number, paint: (c: CanvasRenderingContext2D) => void, repeat = 1): THREE.CanvasTexture {
  const cv = canvas(w, h);
  paint(cv.getContext("2d")!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}

const kits = new Map<boolean, ReturnType<typeof makeKit>>();
/** Shared geometries and materials; `leaned` materials carry the oblique tile-baking shear. */
export function getKit(leaned: boolean): Kit {
  let k = kits.get(leaned);
  if (!k) { k = makeKit(leaned); kits.set(leaned, k); }
  return k;
}
function makeKit(leaned: boolean) {
  // Roof: courses of overlapping tiles (shades multiply the per-instance colour).
  const roofTex = proceduralTexture(64, 64, (c) => {
    c.fillStyle = "#ffffff"; c.fillRect(0, 0, 64, 64);
    for (let r = 0; r < 8; r++) {
      const y = r * 8, off = r % 2 ? 4 : 0;
      for (let i = -1; i < 9; i++) {
        const v = 225 + ((hash2(i, r, 3) & 31) - 16);
        c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(i * 8 + off, y, 8, 8);
        c.fillStyle = "rgba(0,0,0,0.28)"; c.fillRect(i * 8 + off, y, 1, 8);
      }
      c.fillStyle = "rgba(0,0,0,0.34)"; c.fillRect(0, y, 64, 1.4);
      c.fillStyle = "rgba(255,255,255,0.25)"; c.fillRect(0, y + 1.4, 64, 1);
    }
  }, 1);
  roofTex.repeat.set(2, 2.5);
  // Masonry: irregular ashlar courses.
  const stoneTex = proceduralTexture(64, 64, (c) => {
    c.fillStyle = "#8c8579"; c.fillRect(0, 0, 64, 64);
    for (let r = 0; r < 8; r++) {
      let x = (hash2(r, 1, 9) & 7) - 8;
      while (x < 64) {
        const w = 7 + (hash2(x, r, 11) & 7);
        const v = 205 + ((hash2(x, r, 5) & 63) - 32);
        c.fillStyle = `rgb(${v},${v - 3},${v - 9})`; c.fillRect(x + 0.6, r * 8 + 0.6, w - 1.2, 6.8);
        x += w;
      }
    }
  }, 1);
  stoneTex.repeat.set(1.5, 1);
  const plasterTex = proceduralTexture(32, 32, (c) => {
    c.fillStyle = "#ffffff"; c.fillRect(0, 0, 32, 32);
    for (let i = 0; i < 260; i++) { const v = 220 + (hash2(i, 0, 21) & 35); c.fillStyle = `rgb(${v},${v},${v - 4})`; c.fillRect(hash2(i, 1, 21) & 31, hash2(i, 2, 21) & 31, 2, 2); }
    // Timber stud and a dark window band.
    c.fillStyle = "rgba(70,48,30,0.55)"; c.fillRect(0, 0, 32, 2); c.fillRect(0, 0, 2, 32);
    c.fillStyle = "rgba(50,40,35,0.55)"; c.fillRect(9, 12, 4, 6); c.fillRect(21, 12, 4, 6);
  }, 1);

  const std = (o: THREE.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial({ color: "#ffffff", metalness: 0, ...o });
    return leaned ? lean(m) : m;
  };
  return {
    box: baseAt0(new THREE.BoxGeometry(1, 1, 1)),
    gable: gableGeometry(),
    pyramid: baseAt0(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4)),
    cylinder: baseAt0(new THREE.CylinderGeometry(0.94, 1, 1, 12, 1)),
    cone: baseAt0(new THREE.ConeGeometry(1, 1, 12, 1, true)),
    crown: new THREE.IcosahedronGeometry(1, 0),
    rock: new THREE.DodecahedronGeometry(1, 0),
    mat: {
      plaster: std({ map: plasterTex, roughness: 0.92 }),
      roof: std({ map: roofTex, roughness: 0.78, flatShading: true }),
      stone: std({ map: stoneTex, roughness: 0.95 }),
      plain: std({ roughness: 0.9 }),
      foliage: std({ roughness: 0.88, flatShading: true }),
      water: std({ roughness: 0.15, metalness: 0.05 }),
    },
  };
}

export type Kit = ReturnType<typeof makeKit>;
type GeoName = "box" | "gable" | "pyramid" | "cylinder" | "cone" | "crown" | "rock";
type MatName = keyof Kit["mat"];

/** Collects instances per (geometry, material) pair: one draw call each. */
export interface Batch { geo: GeoName; mat: MatName; m: THREE.Matrix4[]; c: THREE.Color[] }
export class Batches {
  readonly map = new Map<string, Batch>();
  private tmp = new THREE.Object3D();
  /** World offset added to every instance (tile origin on the live board). */
  ox = 0;
  oz = 0;
  add(geo: GeoName, mat: MatName, color: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0, rotX = 0, rotZ = 0): void {
    const key = geo + "|" + mat;
    let b = this.map.get(key);
    if (!b) { b = { geo, mat, m: [], c: [] }; this.map.set(key, b); }
    const o = this.tmp;
    o.position.set(x + this.ox, y, z + this.oz); o.rotation.set(rotX, rotY, rotZ, "YXZ"); o.scale.set(sx, sy, sz);
    o.updateMatrix();
    b.m.push(o.matrix.clone());
    b.c.push(new THREE.Color(color));
  }
  build(k: Kit, parent: THREE.Object3D): void { buildBatches(this.map.values(), k, parent); }
}

/** One InstancedMesh per (geometry, material) pair. */
export function buildBatches(batches: Iterable<Batch>, k: Kit, parent: THREE.Object3D): void {
  {
    for (const b of batches) {
      if (!b.m.length) continue;
      const mesh = new THREE.InstancedMesh(k[b.geo], k.mat[b.mat], b.m.length);
      for (let i = 0; i < b.m.length; i++) { mesh.setMatrixAt(i, b.m[i]); mesh.setColorAt(i, b.c[i]); }
      mesh.castShadow = b.mat !== "water";
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      parent.add(mesh);
    }
  }
}

// ---------------------------------------------------------------- ground surface

function smooth(e0: number, e1: number, x: number): number { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
const INV32 = 1 / 4294967296;

/** World-space cobbles: Voronoi cells, returns [edge distance, cell hash]. */
function cobble(wx: number, wy: number): [number, number] {
  const cs = 2.5, gx = wx / cs, gy = wy / cs;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  let d1 = 9, d2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j;
    const h = hash2(cx, cy, 0xc0b);
    const px = cx + 0.15 + (h & 0xffff) / 0xffff * 0.7, py = cy + 0.15 + (h >>> 16) / 0xffff * 0.7;
    const d = Math.hypot(px - gx, py - gy);
    if (d < d1) { d2 = d1; d1 = d; id = h; } else if (d < d2) d2 = d;
  }
  return [(d2 - d1) * cs, id];
}

export function paintGround(t: number, g: TileGeometry, o: RenderOptions, decor: Decor) {
  const s = surface(t);
  const scale = t / S, rot = o.rotation & 3, kind = g.mask.kind;
  const height = new Float32Array(t * t);
  const ac = s.albedo.getContext("2d")!;
  const img = ac.createImageData(t, t), data = img.data;
  for (let j = 0; j < t; j++) for (let i = 0; i < t; i++) {
    const x = (i + 0.5) / scale, y = (j + 0.5) / scale;
    let cx = x, cy = y;
    if (rot === 1) { cx = y; cy = S - x; } else if (rot === 2) { cx = S - x; cy = S - y; } else if (rot === 3) { cx = S - y; cy = x; }
    const k = kind[Math.min(S - 1, Math.floor(cy)) * S + Math.min(S - 1, Math.floor(cx))];
    const wx = o.tx * S + x, wy = o.ty * S + y;
    const grain = (hash2(Math.floor(wx * scale), Math.floor(wy * scale), 77) & 255) / 255 - 0.5;
    let r: number, gg: number, b: number, h: number;
    if (k === K_CITY) {
      const [edge, id] = cobble(wx, wy);
      const n = fbm(wx / 26, wy / 26, 0x7a1e, 2);
      const tone = 0.86 + (id * INV32) * 0.2 + n * 0.12;
      const dome = smooth(0.05, 0.95, edge);
      const mortar = 1 - smooth(0.12, 0.5, edge);
      r = (188 * tone) * (1 - mortar * 0.32); gg = (172 * tone) * (1 - mortar * 0.34); b = (142 * tone) * (1 - mortar * 0.38);
      h = dome * 0.9 + grain * 0.08;
    } else {
      const c = grassColor(wx, wy);
      const tuft = valueNoise(wx / 2.2, wy / 2.2, 0x6a55);
      const blade = valueNoise(wx / 0.9, wy / 0.55, 0x6a56);
      const shade = 0.92 + tuft * 0.12 + (blade - 0.5) * 0.1;
      r = c[0] * shade; gg = c[1] * shade; b = c[2] * shade;
      h = fbm(wx / 12, wy / 12, 0x6a57, 2) * 1.4 + tuft * 0.55 + blade * 0.25;
    }
    const p = (j * t + i) * 4;
    data[p] = r + grain * 6; data[p + 1] = gg + grain * 6; data[p + 2] = b + grain * 6; data[p + 3] = 255;
    height[j * t + i] = h;
  }
  ac.putImageData(img, 0, 0);

  // Painted layers (albedo) and their relief (grey 128 = flat, darker = lower).
  const rc = s.relief.getContext("2d", { willReadFrequently: true })!;
  rc.setTransform(1, 0, 0, 1, 0, 0);
  rc.fillStyle = "rgb(128,128,128)"; rc.fillRect(0, 0, t, t);
  for (const c of [ac, rc]) { c.save(); c.setTransform(scale, 0, 0, scale, 0, 0); c.lineJoin = "round"; c.lineCap = "butt"; }
  const R = (p: Pt) => rotatePoint(p, rot);
  const rng = createRandom("paint:" + g.topologyId + ":" + (o.visualSeed >>> 0));
  const trace = (c: CanvasRenderingContext2D, pts: readonly Pt[]) => { c.beginPath(); c.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y); };
  const detail = o.detail ?? 1;

  // Crops: strips of ploughed land with furrows.
  const CROPS = [["#d8bf62", "#b79f4c"], ["#b6c463", "#94a54f"], ["#c79f62", "#a47e4a"]];
  for (const c of decor.crops) {
    for (const cx of [ac, rc]) { cx.save(); cx.translate(c.x, c.y); cx.rotate(c.a); }
    ac.fillStyle = CROPS[c.c][0]; ac.globalAlpha = 0.92; ac.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ac.globalAlpha = 0.8; ac.strokeStyle = CROPS[c.c][1]; ac.lineWidth = 0.9;
    ac.beginPath(); rc.beginPath();
    for (let y = -c.h / 2 + 1.2; y < c.h / 2; y += 2) { ac.moveTo(-c.w / 2, y); ac.lineTo(c.w / 2, y); rc.moveTo(-c.w / 2, y); rc.lineTo(c.w / 2, y); }
    ac.stroke(); rc.strokeStyle = "rgb(96,96,96)"; rc.lineWidth = 0.9; rc.stroke();
    ac.globalAlpha = 0.55; ac.strokeStyle = "#5f7d34"; ac.lineWidth = 1.2; ac.strokeRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ac.globalAlpha = 1;
    for (const cx of [ac, rc]) cx.restore();
  }
  // Monastery garden.
  if (g.shapes.monastery) {
    const m = R(g.shapes.monastery), r = g.shapes.monastery.r;
    ac.fillStyle = "#8bab5c"; ac.beginPath(); ac.arc(m.x, m.y, r, 0, 6.2832); ac.fill();
    ac.strokeStyle = "rgba(205,190,150,0.9)"; ac.lineWidth = 1.6; ac.beginPath(); ac.arc(m.x, m.y, r * 0.55, 0, 6.2832); ac.stroke();
  }
  // Roads: earth bed sunk into the grass, verges, two worn wheel ruts.
  const roads = g.shapes.roads.map((r) => r.path.map(R));
  for (const p of roads) { trace(ac, p); ac.strokeStyle = "rgba(92,80,46,0.3)"; ac.lineWidth = 17.5; ac.stroke(); }
  for (const p of roads) { trace(ac, p); ac.strokeStyle = "#c4a676"; ac.lineWidth = 14.5; ac.stroke(); }
  for (const p of roads) { trace(ac, p); ac.strokeStyle = "rgba(220,196,148,0.75)"; ac.lineWidth = 10; ac.stroke(); }
  for (const p of roads) { trace(rc, p); rc.strokeStyle = "rgb(112,112,112)"; rc.lineWidth = 15; rc.stroke(); }
  for (const p of roads) { trace(rc, p); rc.strokeStyle = "rgb(104,104,104)"; rc.lineWidth = 11; rc.stroke(); }
  for (const p of roads) {
    for (const off of [-3, 3]) {
      const q = p.map((pt, i) => {
        const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: pt.x - ((b.y - a.y) / l) * off, y: pt.y + ((b.x - a.x) / l) * off };
      });
      trace(ac, q); ac.strokeStyle = "rgba(140,112,72,0.26)"; ac.lineWidth = 2.2; ac.stroke();
      trace(rc, q); rc.strokeStyle = "rgb(80,80,80)"; rc.lineWidth = 1.5; rc.stroke();
    }
    if (detail >= 1) {
      ac.fillStyle = "rgba(118,98,68,0.55)";
      for (let i = 2; i < p.length - 2; i += 2) if (rng.nextFloat() < 0.6) ac.fillRect(p[i].x + (rng.nextFloat() - 0.5) * 10, p[i].y + (rng.nextFloat() - 0.5) * 10, 0.9, 0.9);
    }
  }
  // Terminals: trodden squares.
  for (const tm of g.shapes.terminals) {
    const p = R(tm);
    ac.fillStyle = "rgba(92,80,46,0.45)"; ac.beginPath(); ac.arc(p.x, p.y, tm.r + 1.2, 0, 6.2832); ac.fill();
    ac.fillStyle = tm.kind === "village" ? "#d3be96" : "#ccb183"; ac.beginPath(); ac.arc(p.x, p.y, tm.r, 0, 6.2832); ac.fill();
    rc.fillStyle = "rgb(108,108,108)"; rc.beginPath(); rc.arc(p.x, p.y, tm.r, 0, 6.2832); rc.fill();
  }
  // City lanes.
  if (detail >= 1) {
    ac.strokeStyle = "rgba(150,126,90,0.4)"; ac.lineWidth = 2;
    const hs = decor.houses;
    ac.beginPath();
    for (let i = 0; i + 1 < hs.length; i += 2) { const a = hs[i], b = hs[i + 1]; if (Math.hypot(a.x - b.x, a.y - b.y) < 40) { ac.moveTo(a.x, a.y); ac.lineTo(b.x, b.y); } }
    ac.stroke();
  }
  // Flowers and ambient-occlusion pools under everything that stands.
  if (detail >= 1) {
    const FLOWERS = ["#f6eba2", "#f6f3ea", "#ec9fab", "#b9a6e8"];
    for (const f of decor.flowers) for (let n = 0; n < 5; n++) { ac.fillStyle = FLOWERS[(f.c + n) & 3]; ac.fillRect(f.x + (hash2(n, f.c, Math.floor(f.x)) & 7) * 0.5 - 2, f.y + (hash2(n, 7, Math.floor(f.y)) & 7) * 0.5 - 2, 0.9, 0.9); }
  }
  const ao = (x: number, y: number, r: number, a: number) => {
    const gr = ac.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(30,26,14,${a})`); gr.addColorStop(1, "rgba(30,26,14,0)");
    ac.fillStyle = gr; ac.beginPath(); ac.arc(x, y, r, 0, 6.2832); ac.fill();
  };
  for (const h of decor.houses) ao(h.x, h.y, Math.max(h.w, h.h) * 0.85, 0.32);
  for (const tr of decor.trees) ao(tr.x, tr.y, tr.r * 1.5, 0.34);
  for (const tw of decor.towers) ao(tw.x, tw.y, tw.r * 1.7, 0.3);
  for (const kp of decor.keeps) ao(kp.x, kp.y, kp.r * 1.6, 0.32);
  for (const c of g.shapes.cities) for (const w of c.walls) { trace(ac, w.map(R)); ac.strokeStyle = "rgba(30,26,14,0.16)"; ac.lineWidth = 9; ac.lineCap = "round"; ac.stroke(); ac.lineWidth = 6; ac.stroke(); }
  for (const cx of [ac, rc]) cx.restore();

  // Normals from procedural height + painted relief.
  const rel = rc.getImageData(0, 0, t, t).data;
  for (let i = 0; i < t * t; i++) height[i] += (rel[i * 4] - 128) / 128 * 1.6;
  const nc = s.normal.getContext("2d")!;
  const nimg = nc.createImageData(t, t), nd = nimg.data;
  const texel = S / t, strength = 0.9;
  for (let j = 0; j < t; j++) for (let i = 0; i < t; i++) {
    const hl = height[j * t + Math.max(0, i - 1)], hr = height[j * t + Math.min(t - 1, i + 1)];
    const hu = height[Math.max(0, j - 1) * t + i], hd = height[Math.min(t - 1, j + 1) * t + i];
    const dx = (hr - hl) / (2 * texel) * strength, dy = (hd - hu) / (2 * texel) * strength;
    // Tangent space: +u = east, +v = north (canvas rows go south).
    const nx = -dx, ny = dy, nz = 1, l = Math.hypot(nx, ny, nz);
    const p = (j * t + i) * 4;
    nd[p] = (nx / l * 0.5 + 0.5) * 255; nd[p + 1] = (ny / l * 0.5 + 0.5) * 255; nd[p + 2] = (nz / l * 0.5 + 0.5) * 255; nd[p + 3] = 255;
  }
  nc.putImageData(nimg, 0, 0);
  s.albedoTex.needsUpdate = true;
  s.normalTex.needsUpdate = true;
  return s;
}

// ---------------------------------------------------------------- props

export function buildProps(B: Batches, g: TileGeometry, o: RenderOptions, decor: Decor): void {
  const rot = o.rotation & 3, detail = o.detail ?? 1;
  const R = (p: Pt) => rotatePoint(p, rot);

  // Houses: plaster body, tiled gable roof along the long axis, sometimes a chimney.
  for (const h of decor.houses) {
    const long = h.w >= h.h;
    const wallH = 3.4 + (h.seed & 7) * 0.24;
    const span = Math.min(h.w, h.h), roofH = span * 0.62;
    const ry = -h.a;
    B.add("box", "plaster", PLASTER[(h.seed >>> 3) % PLASTER.length], h.x, 0, h.y, h.w, wallH, h.h, ry);
    if (long) B.add("gable", "roof", ROOFS[h.roof & 3], h.x, wallH, h.y, h.w + 0.9, roofH, h.h + 1.1, ry);
    else B.add("gable", "roof", ROOFS[h.roof & 3], h.x, wallH, h.y, h.h + 0.9, roofH, h.w + 1.1, ry + Math.PI / 2);
    if (detail >= 1 && (h.seed & 7) < 3) {
      const off = (long ? h.w : h.h) * 0.24, ca = long ? ry : ry + Math.PI / 2;
      B.add("box", "stone", "#8a7a68", h.x + Math.cos(ca) * off, wallH + roofH * 0.3, h.y - Math.sin(ca) * off, 1.1, roofH * 0.95, 1.1, ry);
    }
  }
  // City walls: masonry curtain with a crenellated parapet.
  const wallH = 4.4, thick = 3.6;
  for (const c of g.shapes.cities) for (const w0 of c.walls) {
    const w = w0.map(R);
    let acc = 0;
    for (let i = 0; i + 1 < w.length; i++) {
      const a = w[i], b = w[i + 1], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const ang = Math.atan2(dy, dx), ry = -ang;
      B.add("box", "stone", STONE, (a.x + b.x) / 2, 0, (a.y + b.y) / 2, len + thick * 0.55, wallH, thick, ry);
      if (detail < 1) continue;
      for (let d = (2.6 - acc % 2.6) % 2.6; d < len; d += 2.6) {
        const mx = a.x + (dx / len) * d, my = a.y + (dy / len) * d;
        for (const side of [-1, 1]) {
          const nx = (-dy / len) * side * (thick / 2 - 0.45), ny = (dx / len) * side * (thick / 2 - 0.45);
          B.add("box", "stone", STONE_DARK, mx + nx, wallH, my + ny, 1.3, 1.3, 0.9, ry);
        }
      }
      acc += len;
    }
  }
  const tower = (x: number, y: number, r: number, h: number, roof: string) => {
    B.add("cylinder", "stone", STONE, x, 0, y, r, h, r, (x * 7 + y) % 6.28);
    B.add("cone", "roof", roof, x, h, y, r * 1.22, r * 1.7, r * 1.22, (x + y * 3) % 6.28);
  };
  for (const tw of decor.towers) tower(tw.x, tw.y, tw.r, 7.8, TERRACOTTA);
  for (const kp of decor.keeps) {
    B.add("cylinder", "stone", STONE, kp.x, 0, kp.y, kp.r, 9, kp.r);
    B.add("cone", "roof", SLATE, kp.x, 9, kp.y, kp.r * 1.15, kp.r * 1.1, kp.r * 1.15);
    tower(kp.x + kp.r * 0.15, kp.y + kp.r * 0.1, kp.r * 0.5, 15, TERRACOTTA);
  }
  // Gates: gatehouse with a dark passage, flanked by slate-roofed towers.
  for (const gt of g.shapes.gates) {
    const p = R(gt), q = R({ x: gt.x + gt.nx, y: gt.y + gt.ny });
    const a = Math.atan2(q.y - p.y, q.x - p.x), ry = -a;
    B.add("box", "stone", "#c9b88f", p.x, 0, p.y, 10, 6.4, 11, ry);
    B.add("box", "plain", "#2e2721", p.x, 0, p.y, 10.3, 3.9, 4.6, ry);
    tower(p.x - Math.sin(a) * 8.2, p.y + Math.cos(a) * 8.2, 4.6, 9.2, SLATE);
    tower(p.x + Math.sin(a) * 8.2, p.y - Math.cos(a) * 8.2, 4.6, 9.2, SLATE);
  }
  // Terminals: a well for villages, a signpost for crossroads.
  for (const tm of g.shapes.terminals) {
    const p = R(tm);
    if (tm.kind === "village") {
      B.add("cylinder", "stone", STONE, p.x, 0, p.y, 2.7, 1.7, 2.7);
      B.add("cylinder", "water", "#3f6f93", p.x, 0, p.y, 1.75, 1.78, 1.75);
      B.add("box", "plain", "#6b4f35", p.x - 2.2, 0, p.y, 0.5, 4.2, 0.5);
      B.add("box", "plain", "#6b4f35", p.x + 2.2, 0, p.y, 0.5, 4.2, 0.5);
      B.add("gable", "roof", ROOFS[1], p.x, 4.1, p.y, 5.6, 1.6, 3.4);
    } else {
      B.add("box", "plain", "#7d6448", p.x, 0, p.y, 0.7, 5.2, 0.7);
      B.add("box", "plain", "#a68a62", p.x + 1, 4.1, p.y, 3.6, 0.8, 0.35, 0.3);
      B.add("box", "plain", "#a68a62", p.x - 0.8, 3.1, p.y, 3.2, 0.8, 0.35, -1.1);
    }
  }
  // Trees: broadleaf crowns on short trunks, two-tier conifers.
  for (const tr of decor.trees) {
    const r = tr.r, j = (hash2(Math.floor(tr.x * 8), Math.floor(tr.y * 8), 41) & 255) / 255;
    B.add("box", "plain", "#5d4630", tr.x, 0, tr.y, 0.8, r * 0.9, 0.8);
    if (tr.conifer) {
      const c1 = tr.tone > 0.5 ? "#2c5536" : "#33633d", c2 = tr.tone > 0.5 ? "#3a6c44" : "#41774a";
      B.add("cone", "foliage", c1, tr.x, r * 0.45, tr.y, r * 0.95, r * 1.9, r * 0.95, j * 6.28);
      B.add("cone", "foliage", c2, tr.x, r * 1.35, tr.y, r * 0.7, r * 1.6, r * 0.7, j * 3);
    } else {
      const dark = tr.tone > 0.66 ? "#4a7a33" : tr.tone > 0.33 ? "#557f37" : "#44723a";
      const light = tr.tone > 0.5 ? "#6e9b42" : "#78a547";
      B.add("crown", "foliage", dark, tr.x, r * 1.55, tr.y, r, r * 0.86, r, j * 6.28, 0.3);
      if (detail >= 1) B.add("crown", "foliage", light, tr.x - r * 0.22, r * 2.0, tr.y - r * 0.18, r * 0.6, r * 0.52, r * 0.6, j * 2, 0.5);
    }
  }
  if (detail >= 1) {
    for (const b of decor.bushes) B.add("crown", "foliage", "#5a873a", b.x, b.r * 0.35, b.y, b.r, b.r * 0.7, b.r, b.x);
    for (const rk of decor.rocks) B.add("rock", "stone", "#aaa596", rk.x, rk.r * 0.2, rk.y, rk.r, rk.r * 0.6, rk.r * 0.85, rk.x * 3, 0.2);
  }
  // Monastery: low enclosure, cruciform church with slate roofs, west bell tower.
  if (g.shapes.monastery) {
    const m = R(g.shapes.monastery), r = g.shapes.monastery.r;
    const a = createRandom("abbey:" + o.visualSeed).nextFloat() * 0.5 - 0.25, ry = -a;
    const n = 26;
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * 6.2832, t1 = ((i + 1) / n) * 6.2832;
      const ax = m.x + Math.cos(t0) * (r - 1), ay = m.y + Math.sin(t0) * (r - 1), bx = m.x + Math.cos(t1) * (r - 1), by = m.y + Math.sin(t1) * (r - 1);
      B.add("box", "stone", "#c2baa6", (ax + bx) / 2, 0, (ay + by) / 2, Math.hypot(bx - ax, by - ay) + 0.4, 1.8, 1.3, -Math.atan2(by - ay, bx - ax));
    }
    const local = (lx: number, ly: number) => ({ x: m.x + lx * Math.cos(a) - ly * Math.sin(a), y: m.y + lx * Math.sin(a) + ly * Math.cos(a) });
    const nave = local(-r * 0.07, r * 0.01), tran = local(-r * 0.03, 0), bell = local(-r * 0.66, 0);
    B.add("box", "plaster", "#e9dfc7", nave.x, 0, nave.y, r * 1.1, 5.2, r * 0.42, ry);
    B.add("gable", "roof", SLATE, nave.x, 5.2, nave.y, r * 1.1 + 0.6, 3.4, r * 0.42 + 1, ry);
    B.add("box", "plaster", "#e9dfc7", tran.x, 0, tran.y, r * 0.38, 4.8, r * 1.0, ry);
    B.add("gable", "roof", SLATE, tran.x, 4.8, tran.y, r * 1.0 + 0.6, 3.1, r * 0.38 + 1, ry + Math.PI / 2);
    const bs = r * 0.36;
    B.add("box", "stone", "#cbc3af", bell.x, 0, bell.y, bs, 11, bs, ry);
    B.add("pyramid", "roof", TERRACOTTA, bell.x, 11, bell.y, bs + 0.8, 5, bs + 0.8, ry);
    if (detail >= 1) for (let i = 0; i < 4; i++) {
      const t = a + 0.9 + i * 0.5;
      B.add("crown", "foliage", "#5f8a3f", m.x + Math.cos(t) * r * 0.66, 1.6, m.y + Math.sin(t) * r * 0.66, 1.6, 1.8, 1.6, t);
    }
  }
}

// ---------------------------------------------------------------- entry point

/** Render the tile in 3D onto ctx (origin = tile top-left). Returns false if WebGL is unavailable. */
export function renderTile3D(ctx: Ctx, g: TileGeometry, o: RenderOptions): boolean {
  const r = getRig();
  if (!r) return false;
  try {
    const kit = getKit(true);
    const px = o.px, rot = o.rotation & 3;
    if (r.size !== px) { r.renderer.setSize(px, px, false); r.size = px; }
    const decor = generateDecor(g, o.visualSeed, rot, o.tx, o.ty);
    // Nothing may overhang a seam: the neighbouring tile could not draw the overhang.
    const edge = (x: number, y: number) => Math.min(x, y, S - x, S - y);
    decor.houses = decor.houses.filter((h) => edge(h.x, h.y) >= Math.hypot(h.w, h.h) * 0.5 + 1);
    decor.trees = decor.trees.map((t) => ({ ...t, r: Math.min(t.r, edge(t.x, t.y) - 0.8) })).filter((t) => t.r >= 2.2);
    decor.bushes = decor.bushes.filter((b) => edge(b.x, b.y) >= b.r + 0.5);
    const tex = Math.max(64, Math.min(512, px));
    const s = paintGround(tex, g, o, decor);
    r.groundMat.map = s.albedoTex;
    r.groundMat.normalMap = s.normalTex;
    r.groundMat.needsUpdate = true;

    const B = new Batches();
    buildProps(B, g, o, decor);
    B.build(kit, r.objects);
    r.renderer.render(r.scene, r.camera);
    ctx.drawImage(r.renderer.domElement, 0, 0, px, px);
    for (const child of [...r.objects.children]) { (child as THREE.InstancedMesh).dispose(); r.objects.remove(child); }

    // Heraldic shields stay flat and crisp: they are a scoring signal, not scenery.
    if (decor.shields.length) {
      ctx.save();
      ctx.scale(px / S, px / S);
      for (const sh of decor.shields) drawShield(ctx, sh.x, sh.y - 1, sh.seed, 6.5);
      ctx.restore();
    }
    return true;
  } catch (e) {
    console.warn("3D tile renderer unavailable, falling back to 2D", e);
    rig = null;
    return false;
  }
}
