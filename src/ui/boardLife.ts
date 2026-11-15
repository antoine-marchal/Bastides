/**
 * "Life" on the 3D board: every completed city, road or monastery raises a waving banner
 * with its points (winner's colours, or a neutral banner when nobody claimed it); a fresh
 * completion is celebrated with the banner rising, confetti and a brief golden glow over
 * the region; completed cities get chimney smoke. Purely decorative: it reads the state
 * and never changes it. Honours prefers-reduced-motion (no waving, no particles).
 */
import * as THREE from "three";
import { TILE_SIZE } from "../core/types";
import { K_CITY, K_FIELD, K_MONASTERY, K_ROAD } from "../procedural/geometry/masks";
import { featureAt, generateGeometry, geometrySeedOf, rotatedAnchor, visualSeedOf } from "../procedural/geometry/tileGeometry";
import { getTopology } from "../procedural/topology/catalog";
import { generateDecor } from "../procedural/rendering/decor";
import { distinctTiles, find, regionPoints, tileTopology, topoIndex } from "../game/gameEngine";
import type { GameState, Region } from "../game/state";
import { PLAYER_COLORS } from "./dom";

const S = TILE_SIZE;
const POLE = 46;
const RAISE_MS = 1100, GLOW_MS = 1900;

const reducedMotion = (): boolean => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// ---------------------------------------------------------------- particles (one draw call)

const PARTICLE_VS = `
  attribute float size;
  attribute float alpha;
  attribute float shape;
  attribute vec3 color;
  varying float vAlpha; varying float vShape; varying vec3 vColor;
  uniform float uScale;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * uScale / -mv.z;
    vAlpha = alpha; vShape = shape; vColor = color;
  }`;
const PARTICLE_FS = `
  varying float vAlpha; varying float vShape; varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p);
    float a;
    if (vShape < 0.5) a = smoothstep(0.5, 0.0, d) * 0.85;                 // soft smoke puff
    else a = step(abs(p.x), 0.5 - 0.22 * vShape) * step(abs(p.y), 0.32);  // confetti slip
    if (a * vAlpha < 0.01) discard;
    gl_FragColor = vec4(vColor, a * vAlpha);
    #include <colorspace_fragment>
  }`;

interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; t0: number; life: number; s0: number; s1: number; r: number; g: number; b: number; shape: number; drag: number; grav: number }

class Particles {
  readonly points: THREE.Points;
  private list: Particle[] = [];
  private readonly cap = 900;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  constructor() {
    const n = this.cap;
    this.geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("size", new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("shape", new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({ vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, uniforms: { uScale: { value: 500 } }, transparent: true, depthWrite: false });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
  }
  get alive(): number { return this.list.length; }
  setScale(pxPerUnitAtUnitDistance: number): void { this.mat.uniforms.uScale.value = pxPerUnitAtUnitDistance; }
  add(p: Particle): void { if (this.list.length < this.cap) this.list.push(p); }
  update(now: number): void {
    this.list = this.list.filter((p) => now - p.t0 < p.life);
    const pos = this.geo.attributes.position.array as Float32Array, col = this.geo.attributes.color.array as Float32Array;
    const size = this.geo.attributes.size.array as Float32Array, alpha = this.geo.attributes.alpha.array as Float32Array, shape = this.geo.attributes.shape.array as Float32Array;
    this.list.forEach((p, i) => {
      const t = (now - p.t0) / 1000, k = (now - p.t0) / p.life;
      const damp = (1 - Math.exp(-p.drag * t)) / p.drag;
      pos[i * 3] = p.x + p.vx * damp + Math.sin(t * 3 + p.r * 9) * p.shape * 1.5;
      pos[i * 3 + 1] = Math.max(0.2, p.y + p.vy * damp - 0.5 * p.grav * t * t);
      pos[i * 3 + 2] = p.z + p.vz * damp;
      col[i * 3] = p.r; col[i * 3 + 1] = p.g; col[i * 3 + 2] = p.b;
      size[i] = p.s0 + (p.s1 - p.s0) * k;
      alpha[i] = p.shape > 0 ? (k < 0.8 ? 1 : (1 - k) / 0.2) : Math.sin(Math.PI * Math.min(1, k * 1.15)) * 0.8;
      shape[i] = p.shape > 0 ? 0.5 + 0.5 * Math.abs(Math.sin(t * 7 + p.r * 20)) : 0; // confetti tumbles
    });
    for (const name of ["position", "color", "size", "alpha", "shape"]) this.geo.attributes[name].needsUpdate = true;
    this.geo.setDrawRange(0, this.list.length);
  }
  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------- banners

const clothTime = { value: 0 };
const clothGeometry = new THREE.PlaneGeometry(26, 16, 20, 6).translate(13, 0, 0);

function clothMaterial(map: THREE.Texture, phase: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: "#ffffff", emissiveIntensity: 0.32, side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.82 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = clothTime;
    sh.uniforms.uPhase = { value: phase };
    sh.vertexShader = "uniform float uTime;\nuniform float uPhase;\n" + sh.vertexShader
      .replace("#include <beginnormal_vertex>", `
        float clothK = clamp(position.x / 26.0, 0.0, 1.0);
        float clothA = position.x * 0.34 - uTime * 4.0 + uPhase + position.y * 0.08;
        float clothB = position.x * 0.85 - uTime * 6.3 + uPhase * 1.7;
        float clothW = (sin(clothA) * 2.4 + sin(clothB) * 0.6) * clothK;
        float clothD = (cos(clothA) * 0.82 + cos(clothB) * 0.51) * clothK;
        vec3 objectNormal = normalize(vec3(-clothD, 0.0, 1.0));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace("#include <begin_vertex>", `
        vec3 transformed = vec3(position);
        transformed.z += clothW;
        transformed.y -= clothK * clothK * 2.0;`);
  };
  m.customProgramCacheKey = () => "cloth";
  return m;
}

function bannerTexture(colors: string[], points: number): THREE.CanvasTexture {
  const w = 256, h = 160, c = newCanvas(w, h), x = c.getContext("2d")!;
  // Swallowtail: a V notch at the fly end.
  x.beginPath(); x.moveTo(0, 0); x.lineTo(w, 0); x.lineTo(w - 52, h / 2); x.lineTo(w, h); x.lineTo(0, h); x.closePath();
  x.save(); x.clip();
  const neutral = colors.length === 0;
  const fills = neutral ? ["#efe4c8"] : colors;
  fills.forEach((f, i) => { x.fillStyle = f; x.fillRect(0, (h / fills.length) * i, w, h / fills.length + 1); });
  // Hoist band and a hem, in lime-white ink.
  x.fillStyle = neutral ? "rgba(59,45,28,0.25)" : "rgba(255,250,235,0.35)";
  x.fillRect(0, 0, 18, h);
  x.strokeStyle = neutral ? "rgba(59,45,28,0.5)" : "rgba(255,250,235,0.75)"; x.lineWidth = 6;
  x.beginPath(); x.moveTo(0, 5); x.lineTo(w - 4, 5); x.moveTo(0, h - 5); x.lineTo(w - 4, h - 5); x.stroke();
  x.restore();
  x.font = 'bold 92px Georgia, "Times New Roman", serif';
  x.textAlign = "center"; x.textBaseline = "middle";
  x.lineJoin = "round"; x.lineWidth = 12;
  x.strokeStyle = neutral ? "rgba(255,250,235,0.9)" : "rgba(30,20,10,0.75)";
  x.fillStyle = neutral ? "#3b2d1c" : "#fffaf0";
  x.strokeText(String(points), 112, h / 2 + 4); x.fillText(String(points), 112, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

interface Banner {
  key: string;
  group: THREE.Group;
  cloth: THREE.Mesh;
  born: number;
  colors: string[];
  smoke: { x: number; y: number; z: number; next: number }[];
  glow: THREE.Mesh[];
}

export class BoardLife {
  readonly root = new THREE.Group();
  private particles = new Particles();
  private banners = new Map<string, Banner>();
  private signature = "";
  private primed = false;
  private poleGeo = new THREE.CylinderGeometry(0.6, 0.8, POLE, 8).translate(0, POLE / 2, 0);
  private poleMat = new THREE.MeshStandardMaterial({ color: "#5a412b", roughness: 0.8 });
  private finialGeo = new THREE.SphereGeometry(1.7, 12, 8);
  private finialMat = new THREE.MeshStandardMaterial({ color: "#d9b44a", roughness: 0.35, metalness: 0.6 });
  private footGeo = new THREE.CylinderGeometry(2.2, 2.6, 1.2, 10).translate(0, 0.6, 0);
  private footMat = new THREE.MeshStandardMaterial({ color: "#a39c8c", roughness: 0.95 });
  readonly motion = !reducedMotion();

  constructor() {
    this.root.add(this.particles.points);
  }

  /** True while something moves on its own (waving banners, particles, rising flags). */
  get animating(): boolean { return this.motion && (this.banners.size > 0 || this.particles.alive > 0); }
  /** True while banners rise (their poles' shadows must follow). */
  raising(now: number): boolean { for (const b of this.banners.values()) if (now - b.born < RAISE_MS) return true; return false; }

  /** Reconcile banners with the completed regions of the state. */
  sync(st: GameState | null, now: number): void {
    let done = 0;
    if (st) for (const r of st.regions.values()) if (r.done && r.kind !== "field") done++;
    const sig = st ? `${st.tiles.length}:${st.log.length}:${done}` : "";
    if (sig === this.signature) return;
    this.signature = sig;
    const want = new Set<string>();
    if (st) for (const [root, region] of st.regions) {
      if (!region.done || region.kind === "field") continue;
      const key = region.kind + ":" + root;
      want.add(key);
      if (!this.banners.has(key)) this.addBanner(st, key, root, region, this.primed ? now : -1e9);
    }
    for (const [k, b] of this.banners) if (!want.has(k)) { this.disposeBanner(b); this.banners.delete(k); }
    this.primed = true;
  }

  private addBanner(st: GameState, key: string, root: number, region: Region, born: number): void {
    const ev = st.log.find((e) => e.node === root && !e.final);
    const points = ev ? ev.points : regionPoints(st, region, false).points;
    const colors = (ev?.winningPlayerIds ?? []).map((id) => PLAYER_COLORS[st.config.players.find((p) => p.id === id)?.color ?? 0]);
    // Plant it on the region's tile nearest to its centroid, at that feature's anchor.
    const tiles = distinctTiles(region);
    let cx = 0, cy = 0;
    for (const ti of tiles) { cx += st.tiles[ti].x; cy += st.tiles[ti].y; }
    cx /= tiles.length; cy /= tiles.length;
    const ti = tiles.reduce((a, b) => (Math.hypot(st.tiles[a].x - cx, st.tiles[a].y - cy) <= Math.hypot(st.tiles[b].x - cx, st.tiles[b].y - cy) ? a : b));
    const t = st.tiles[ti];
    const n = topoIndex(tileTopology(t)).n;
    let f = 0;
    for (let i = 0; i < n; i++) if (find(st, t.base + i) === root) { f = i; break; }
    const g = generateGeometry(t.def.topologyId, geometrySeedOf(t.def.seed));
    const a = rotatedAnchor(g, t.rotation, f);
    // Beside the anchor so a meeple put back there later is not speared.
    const px = t.x * S + a.x + 9, pz = t.y * S + a.y + 5;

    const group = new THREE.Group();
    group.position.set(px, 0, pz);
    const pole = new THREE.Mesh(this.poleGeo, this.poleMat);
    const finial = new THREE.Mesh(this.finialGeo, this.finialMat);
    finial.position.y = POLE + 0.8;
    const foot = new THREE.Mesh(this.footGeo, this.footMat);
    const tex = bannerTexture(colors, points);
    const cloth = new THREE.Mesh(clothGeometry, clothMaterial(tex, (root * 2.399) % 6.283));
    cloth.position.set(0.6, POLE - 9.5, 0);
    for (const m of [pole, finial, foot]) { m.castShadow = true; m.receiveShadow = true; }
    cloth.receiveShadow = true;
    group.add(pole, finial, foot, cloth);
    this.root.add(group);

    // Chimney smoke over completed cities: a few chimneys of houses inside the region.
    const smoke: Banner["smoke"] = [];
    if (region.kind === "city" && this.motion) {
      for (const tj of tiles) {
        const u = st.tiles[tj];
        const gu = generateGeometry(u.def.topologyId, geometrySeedOf(u.def.seed));
        const decor = generateDecor(gu, visualSeedOf(u.def.seed), u.rotation & 3, u.x, u.y);
        for (const hs of decor.houses) {
          if ((hs.seed & 7) >= 3 || smoke.length >= 6) continue;
          const fh = featureAt(gu, u.rotation, hs.x, hs.y);
          if (fh < 0 || find(st, u.base + fh) !== root) continue;
          const long = hs.w >= hs.h, ry = -hs.a, ca = long ? ry : ry + Math.PI / 2, off = (long ? hs.w : hs.h) * 0.24;
          const wallH = 3.4 + (hs.seed & 7) * 0.24, roofH = Math.min(hs.w, hs.h) * 0.62;
          smoke.push({ x: u.x * S + hs.x + Math.cos(ca) * off, y: wallH + roofH * 1.3, z: u.y * S + hs.y - Math.sin(ca) * off, next: 0 });
        }
      }
    }

    // Golden glow over the region, fading out (fresh completions only).
    const glow: THREE.Mesh[] = [];
    const fresh = born > 0 && this.motion;
    if (fresh) {
      const plane = new THREE.PlaneGeometry(S, S).rotateX(-Math.PI / 2);
      for (const tj of tiles) {
        const u = st.tiles[tj];
        const mesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: regionMask(st, tj, root), transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }));
        mesh.position.set(u.x * S + S / 2, 0.6, u.y * S + S / 2);
        mesh.renderOrder = 7;
        this.root.add(mesh);
        glow.push(mesh);
      }
      this.burst(px, POLE - 4, pz, colors.length ? colors : ["#efe4c8"], born);
    }
    this.banners.set(key, { key, group, cloth, born: fresh ? born : -1e9, colors, smoke, glow });
  }

  private burst(x: number, y: number, z: number, colors: string[], now: number): void {
    const pal = [...colors, "#e9c75a", "#fff6dc"].map((c) => new THREE.Color(c));
    for (let i = 0; i < 110; i++) {
      const a = Math.random() * Math.PI * 2, up = 18 + Math.random() * 34, out = 10 + Math.random() * 30;
      const c = pal[i % pal.length];
      this.particles.add({ x, y, z, vx: Math.cos(a) * out, vy: up, vz: Math.sin(a) * out, t0: now + Math.random() * 120, life: 1600 + Math.random() * 900,
        s0: 2.6, s1: 2.2, r: c.r, g: c.g, b: c.b, shape: 1, drag: 1.6, grav: 26 });
    }
  }

  /** Advance animations; `pxScale` = pixels per world unit at distance 1 (point sizes), `zoom` = px per unit. */
  update(now: number, pxScale: number, zoom = 1): void {
    // Never smaller than ~44 px tall on screen.
    const minScale = Math.max(1, 60 / (zoom * POLE));
    this.particles.setScale(pxScale);
    clothTime.value = this.motion ? now / 1000 : 0;
    for (const b of this.banners.values()) {
      const k = Math.min(1, (now - b.born) / RAISE_MS);
      // Rise with a little overshoot, then unfurl.
      const back = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);
      b.group.scale.set(minScale, minScale * Math.max(0.02, back), minScale);
      b.cloth.scale.x = Math.max(0.02, Math.min(1, (k - 0.35) / 0.5));
      if (b.glow.length) {
        const gk = (now - b.born) / GLOW_MS;
        if (gk >= 1) { for (const m of b.glow) { m.removeFromParent(); const mm = m.material as THREE.MeshBasicMaterial; mm.map?.dispose(); mm.dispose(); } b.glow = []; }
        else for (const m of b.glow) (m.material as THREE.MeshBasicMaterial).opacity = Math.sin(Math.PI * Math.min(1, gk * 1.6)) * (1 - gk) * 1.6;
      }
      if (this.motion) for (const s of b.smoke) {
        if (now < s.next) continue;
        s.next = now + 420 + Math.random() * 520;
        const shade = 0.82 + Math.random() * 0.12;
        this.particles.add({ x: s.x, y: s.y, z: s.z, vx: 3.5 + Math.random() * 2, vy: 9 + Math.random() * 3, vz: -1 + Math.random() * 2, t0: now, life: 3200 + Math.random() * 1200,
          s0: 3.2, s1: 11, r: shade, g: shade, b: shade * 0.98, shape: 0, drag: 0.35, grav: 0 });
      }
    }
    this.particles.update(now);
  }

  private disposeBanner(b: Banner): void {
    b.group.removeFromParent();
    const m = b.cloth.material as THREE.MeshStandardMaterial;
    m.map?.dispose(); m.dispose();
    for (const g of b.glow) { g.removeFromParent(); const mm = g.material as THREE.MeshBasicMaterial; mm.map?.dispose(); mm.dispose(); }
  }

  dispose(): void {
    for (const b of this.banners.values()) this.disposeBanner(b);
    this.banners.clear();
    this.particles.dispose();
    for (const x of [this.poleGeo, this.poleMat, this.finialGeo, this.finialMat, this.footGeo, this.footMat]) x.dispose();
    this.root.removeFromParent();
  }
}

/** Soft golden mask of the region's pixels on one tile. */
function regionMask(st: GameState, ti: number, root: number): THREE.CanvasTexture {
  const t = st.tiles[ti];
  const g = generateGeometry(t.def.topologyId, geometrySeedOf(t.def.seed));
  const topo = getTopology(t.def.topologyId);
  const nc = topo.cities.length, nr = topo.roads.length, nf = topo.fields.length, r = t.rotation & 3;
  const c = newCanvas(S, S), x = c.getContext("2d")!, img = x.createImageData(S, S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    let cx = i, cy = j;
    if (r === 1) { cx = j; cy = S - 1 - i; } else if (r === 2) { cx = S - 1 - i; cy = S - 1 - j; } else if (r === 3) { cx = S - 1 - j; cy = i; }
    const k = cy * S + cx, kd = g.mask.kind[k], id = g.mask.id[k];
    const f = kd === K_CITY ? id : kd === K_ROAD ? nc + id : kd === K_FIELD ? nc + nr + id : kd === K_MONASTERY ? nc + nr + nf : -1;
    if (f < 0 || find(st, t.base + f) !== root) continue;
    const p = (j * S + i) * 4;
    img.data[p] = 255; img.data[p + 1] = 214; img.data[p + 2] = 110; img.data[p + 3] = 140;
  }
  x.putImageData(img, 0, 0);
  // Feather the edge.
  const soft = newCanvas(S, S), sx = soft.getContext("2d")!;
  sx.filter = "blur(2px)"; sx.drawImage(c, 0, 0);
  const tex = new THREE.CanvasTexture(soft);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

