/**
 * Developer tool: topology and geometry inspector.
 * Pick the four edges, browse the valid topologies, change seeds, and look at interfaces,
 * coloured regions, raw masks, skeleton graphs, continuity matrices and the comparison
 * between the expected topology and the one rebuilt from the mask.
 */
import { PORT_NAMES, SIDE_NAMES, TILE_SIZE, Terrain } from "../../core/types";
import type { TileEdges } from "../../core/types";
import { rotatePoint, sidePoint } from "../../core/coordinates";
import { applyUnchecked, createGame, legalPlacements } from "../../game/gameEngine";
import { DEFAULT_DECK_PARAMS, TurnPhase } from "../../game/state";
import { K_CITY, K_FIELD, K_MONASTERY, K_ROAD, K_TERMINAL, rasterize } from "../../procedural/geometry/masks";
import { MAX_ATTEMPTS, generateGeometry, geometrySeedOf, tryGeometry, visualSeedOf } from "../../procedural/geometry/tileGeometry";
import { validateMask } from "../../procedural/geometry/validator";
import { renderTile } from "../../procedural/rendering/tileRenderer";
import { ALL_EDGE_CONFIGS, catalog, getTopology, rotateTopology, topologiesForEdges } from "../../procedural/topology/catalog";
import { edgesToString } from "../../procedural/topology/generator";
import { fieldContinuity, mainContinuity, physicalRoadContinuity } from "../../procedural/topology/validator";
import type { App } from "../app";
import { createBoardView } from "../boardRenderer";
import type { Board } from "../boardRenderer";
import { icon } from "../heraldry";
import { button, h, modal, replace, select } from "../dom";
import { menuScreen } from "./menu";

const REGION_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990"];
const TERRAINS: [string, string][] = [["0", "Prairie"], ["1", "Chemin"], ["2", "Cité"]];

export function labScreen(app: App) {
  let edges: number[] = [Terrain.CITY, Terrain.ROAD, Terrain.GRASS, Terrain.ROAD];
  let choice = 0;
  let seed = 1;
  const show = { interfaces: true, regions: false, mask: false, graph: true };
  const big = h("canvas", { class: "big", width: 512, height: 512 });
  const info = h("div", { class: "col" });
  const controls = h("div", { class: "col" });
  let assembled: Board | null = null;

  const matrix = (title: string, labels: readonly string[], m: boolean[][]) =>
    h("div", null, h("div", { class: "small muted" }, title), h("table", { class: "matrix" },
      h("tr", null, h("th"), labels.map((l) => h("th", null, l))),
      m.map((row, i) => h("tr", null, h("th", null, labels[i]), row.map((v) => h("td", { class: v ? "on" : "" }, v ? "1" : "·"))))));

  const draw = () => {
    const options = topologiesForEdges(edges as unknown as TileEdges);
    if (choice >= options.length) choice = 0;
    const opt = options[choice];
    const topo = rotateTopology(getTopology(opt.id), opt.rotation);
    const rot = opt.rotation;
    const ctx = big.getContext("2d")!;
    const scale = 512 / TILE_SIZE;
    let error = "";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, 512, 512);
    let g;
    try { g = generateGeometry(opt.id, geometrySeedOf(seed)); } catch (e) { error = (e as Error).message; }
    const R = (p: { x: number; y: number }) => rotatePoint(p, rot);
    if (g) {
      renderTile(ctx, g, { px: 512, tx: 0, ty: 0, rotation: rot, visualSeed: visualSeedOf(seed), detail: 2 });
      if (show.mask || show.regions) {
        const img = ctx.createImageData(512, 512);
        const nc = topo.cities.length, nr = topo.roads.length;
        for (let j = 0; j < 512; j++) for (let i = 0; i < 512; i++) {
          const c = rotatePoint({ x: (i + 0.5) / scale, y: (j + 0.5) / scale }, (4 - rot) & 3);
          const k = Math.min(127, Math.floor(c.y)) * 128 + Math.min(127, Math.floor(c.x));
          const kd = g.mask.kind[k], id = g.mask.id[k];
          let col = "#000000";
          if (show.regions) col = kd === K_CITY ? REGION_COLORS[id % 10] : kd === K_ROAD ? REGION_COLORS[(nc + id) % 10] : kd === K_FIELD ? REGION_COLORS[(nc + nr + id) % 10] : kd === K_MONASTERY ? "#ffffff" : "#222222";
          else col = ["#5a9c3c", "#c9ad7c", "#b4553a", "#444444", "#6c7f96"][kd];
          const p = (j * 512 + i) * 4;
          img.data[p] = parseInt(col.slice(1, 3), 16); img.data[p + 1] = parseInt(col.slice(3, 5), 16); img.data[p + 2] = parseInt(col.slice(5, 7), 16); img.data[p + 3] = show.mask && !show.regions ? 255 : 165;
        }
        const tmp = document.createElement("canvas"); tmp.width = tmp.height = 512;
        tmp.getContext("2d")!.putImageData(img, 0, 0);
        ctx.drawImage(tmp, 0, 0);
      }
      ctx.save(); ctx.scale(scale, scale);
      if (show.graph) {
        ctx.lineWidth = 1; ctx.strokeStyle = "#111"; ctx.fillStyle = "#ffe14d";
        for (const r of g.shapes.roads) { ctx.beginPath(); r.path.map(R).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); for (const p of r.path.map(R)) ctx.fillRect(p.x - 0.7, p.y - 0.7, 1.4, 1.4); }
        ctx.strokeStyle = "#7a1fa2";
        for (const c of g.shapes.cities) for (const w of c.walls) { ctx.beginPath(); w.map(R).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); }
        ctx.strokeStyle = "#d81b60"; ctx.lineWidth = 1.2;
        for (const t of g.shapes.terminals) { const p = R(t); ctx.beginPath(); ctx.arc(p.x, p.y, t.r, 0, 6.2832); ctx.stroke(); }
        for (const gt of g.shapes.gates) { const p = R(gt); ctx.strokeRect(p.x - 3, p.y - 3, 6, 6); }
        ctx.font = "5px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        g.anchors.forEach((a, f) => { const p = R(a); ctx.fillStyle = "#fff"; ctx.strokeStyle = "#111"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 6.2832); ctx.fill(); ctx.stroke(); ctx.fillStyle = "#111"; ctx.fillText(String(f), p.x, p.y + 0.3); });
      }
      if (show.interfaces) {
        ctx.font = "bold 5.5px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (let s = 0; s < 4; s++) {
          const inward = [[0, 1], [-1, 0], [0, -1], [1, 0]][s];
          const tag = (t: number, text: string, fill: string) => { const p = sidePoint(s as 0, t); const x = p.x + inward[0] * 6, y = p.y + inward[1] * 6; ctx.fillStyle = fill; ctx.fillRect(x - 7, y - 4, 14, 8); ctx.fillStyle = "#fff"; ctx.fillText(text, x, y + 0.3); };
          if (topo.edges[s] !== Terrain.GRASS) tag(64, SIDE_NAMES[s], topo.edges[s] === Terrain.CITY ? "#8f2f1f" : "#7a5a20");
          if (topo.edges[s] !== Terrain.CITY) { tag(30, PORT_NAMES[s * 2], "#2f6b2a"); tag(98, PORT_NAMES[s * 2 + 1], "#2f6b2a"); }
        }
      }
      ctx.restore();
    }
    // ---- controls
    const edgeSel = (s: number) => h("label", null, SIDE_NAMES[s], select(TERRAINS, String(edges[s]), (v) => { edges[s] = Number(v); choice = 0; draw(); }));
    const seedInput = h("input", { type: "number", value: seed, min: 0, style: { width: "110px" }, onchange: () => { seed = Math.max(0, Math.floor(Number(seedInput.value) || 0)); draw(); } });
    const toggle = (key: keyof typeof show, label: string) => h("label", null, h("input", { type: "checkbox", checked: show[key], onchange: (e: Event) => { show[key] = (e.target as HTMLInputElement).checked; draw(); } }), label);
    replace(controls,
      h("div", { class: "row" }, button([icon("back", 16), "Menu"], () => app.show(menuScreen), "small"), h("h2", { style: { margin: "0" } }, "Générateur de tuiles")),
      h("div", { class: "card col" }, h("h3", null, "Bordures"), h("div", { class: "row" }, [0, 1, 2, 3].map(edgeSel)),
        h("div", { class: "small muted" }, `${edgesToString(edges as unknown as TileEdges)} — ${options.length} topologie(s) valide(s)`),
        h("select", { size: Math.min(8, Math.max(2, options.length)), style: { width: "100%" }, onchange: (e: Event) => { choice = (e.target as HTMLSelectElement).selectedIndex; draw(); } },
          options.map((o, i) => h("option", { selected: i === choice }, `${o.id} · rotation ${o.rotation}`)))),
      h("div", { class: "card col" }, h("h3", null, "Seed de tuile"),
        h("div", { class: "row" }, seedInput, button("Variante", () => { seed = (Math.random() * 0xffffffff) >>> 0; draw(); }, "small"), button("+1", () => { seed++; draw(); }, "small")),
        h("div", { class: "small muted mono" }, `géométrie ${geometrySeedOf(seed)} · visuel ${visualSeedOf(seed)}`)),
      h("div", { class: "card col" }, h("h3", null, "Calques"), toggle("interfaces", "Interfaces et ports"), toggle("regions", "Régions colorées"), toggle("mask", "Masque logique (terrains)"), toggle("graph", "Graphe : squelettes, terminaisons, ancres")),
      h("div", { class: "card col" }, h("h3", null, "Catalogue"), h("div", { class: "small muted" }, `${catalog().size} topologies canoniques, 81 bordures, 24 classes de rotation.`),
        button("Générer les 81 configurations", showAll), button("Assembler plusieurs tuiles", showAssembly)));
    // ---- info
    const v = g ? validateMask(getTopology(opt.id), rasterize(g.shapes, 256)) : null;
    const canon = getTopology(opt.id);
    const fmtField = (f: { ports: number[]; adjacentCityIds: number[] }) => `{${[...f.ports].sort((a, b) => a - b).map((p) => PORT_NAMES[p]).join(" ") || "∅"} | cités ${f.adjacentCityIds.join(",") || "—"}}`;
    const attempts = g ? Array.from({ length: g.attempt }, (_, a) => tryGeometry(canon, geometrySeedOf(seed), a).errors[0]) : [];
    replace(info,
      h("div", { class: "card" }, h("h3", null, "Topologie"),
        h("div", { class: "mono" }, opt.id, ` · rotation ${opt.rotation}`),
        h("div", { class: "small" }, `Cités : ${topo.cities.map((c) => `#${c.id}[${c.sides.map((s) => SIDE_NAMES[s]).join("")}]${c.shields ? "⛨" : ""}`).join(" ") || "—"}`),
        h("div", { class: "small" }, `Chemins : ${topo.roads.map((r) => `#${r.id}[${r.sides.map((s) => SIDE_NAMES[s]).join("")}]${r.terminalIds.length ? "→" + topo.terminals[0].kind : ""}`).join(" ") || "—"}`),
        h("div", { class: "small" }, `Prairies : ${topo.fields.map((f) => `#${f.id}${fmtField(f)}`).join(" ") || "—"}`),
        h("div", { class: "small" }, `Abbaye : ${topo.monastery ? "oui" : "non"}`)),
      h("div", { class: "card" }, h("h3", null, "Validation indépendante (masque 256 px)"),
        error ? h("div", { class: "err" }, error) : null,
        v ? h("div", { class: v.ok ? "ok" : "err" }, v.ok ? [icon("check", 15), " La topologie reconstruite est identique à la topologie attendue."] : [icon("close", 15), " Divergence :"]) : null,
        v && !v.ok ? v.errors.map((e) => h("div", { class: "err small" }, e)) : null,
        g ? h("div", { class: "small muted" }, g.attempt === MAX_ATTEMPTS ? "Géométrie de repli déterministe." : `Tentative retenue : ${g.attempt + 1} / ${MAX_ATTEMPTS}.`) : null,
        attempts.map((e, i) => h("div", { class: "small muted" }, `Tentative ${i + 1} rejetée : ${e}`)),
        v ? h("div", { class: "small", style: { marginTop: "6px" } }, h("div", null, "Attendu : ", canon.fields.map(fmtField).join(" ") || "aucune prairie"), h("div", null, "Reconstruit : ", v.fields.map(fmtField).join(" ") || "aucune prairie"), h("div", null, "Groupes physiques de chemins : ", JSON.stringify(v.roadGroups))) : null),
      h("div", { class: "card" }, h("h3", null, "Matrices de continuité"),
        matrix("Cités (interfaces principales)", SIDE_NAMES, mainContinuity(topo, "city")),
        matrix("Chemins — score", SIDE_NAMES, mainContinuity(topo, "road")),
        matrix("Chemins — physique", SIDE_NAMES, physicalRoadContinuity(topo)),
        matrix("Prairies (8 ports)", PORT_NAMES, fieldContinuity(topo))));
  };

  const showAll = () => {
    const grid = h("div", { class: "gridall" });
    let failures = 0;
    for (const e of ALL_EDGE_CONFIGS) {
      const o = topologiesForEdges(e)[0];
      const c = h("canvas", { width: 128, height: 128, title: `${edgesToString(e)} — ${o.id}` });
      try { renderTile(c.getContext("2d")!, generateGeometry(o.id, geometrySeedOf(seed)), { px: 128, tx: 0, ty: 0, rotation: o.rotation, visualSeed: visualSeedOf(seed) }); } catch { failures++; }
      c.onclick = () => { edges = [...e]; choice = 0; m.close(); draw(); };
      grid.appendChild(c);
    }
    const m = modal("Les 81 configurations de bordure", h("div", { class: "lab" , style: { display: "block", padding: "0" } }, h("p", { class: failures ? "err" : "ok" }, failures ? `${failures} échec(s) de génération.` : "81 / 81 configurations générées et validées (première topologie de chacune, 128 × 128 px)."), grid), [button("Fermer", () => m.close(), "primary")], () => {});
  };

  const showAssembly = () => {
    const canvas = h("canvas", { class: "board", style: { position: "static", width: "100%", height: "60vh", borderRadius: "8px" } });
    const m = modal("Tuiles assemblées", h("div", null, h("p", { class: "muted small" }, "Plateau aléatoire : vérifiez la continuité des chemins, des cités et des prairies d'une tuile à l'autre. Glisser et molette pour explorer."), canvas),
      [button("Autre tirage", () => build()), button("Fermer", () => m.close(), "primary")], () => { assembled?.destroy(); assembled = null; });
    const view = (assembled = createBoardView(canvas, app.cache, app.settings.board3d));
    view.interactive = false;
    const build = () => {
      const s = createGame({ mode: "sandbox", deckSize: 0, params: { ...DEFAULT_DECK_PARAMS, diversity: 1.6 }, farmers: true, seed: "lab-" + ((Math.random() * 1e9) | 0), players: [{ id: "a", name: "", color: 0, kind: "bot" }, { id: "b", name: "", color: 1, kind: "bot" }] });
      for (let i = 0; i < 24 && s.phase === TurnPhase.PLACE_TILE; i++) {
        const ps = legalPlacements(s).sort((p, q) => Math.hypot(p.x, p.y) - Math.hypot(q.x, q.y));
        applyUnchecked(s, { type: "PLACE_TILE", ...ps[0] });
        if ((s.phase as TurnPhase) === TurnPhase.PLACE_MEEPLE) applyUnchecked(s, { type: "SKIP_MEEPLE" });
      }
      view.setState(s);
      setTimeout(() => view.fit(), 30);
    };
    build();
  };

  draw();
  const el = h("div", { class: "lab" }, controls, h("div", { class: "stage" }, big, h("div", { class: "muted small" }, "Rendu 512 px d'une tuile nominale de 128 × 128 px (zoom ×4).")), info);
  void K_TERMINAL;
  return { el, dispose: () => assembled?.destroy() };
}
