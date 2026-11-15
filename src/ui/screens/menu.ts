import { createGame, legalPlacements, applyUnchecked } from "../../game/gameEngine";
import { DEFAULT_DECK_PARAMS, TurnPhase } from "../../game/state";
import { loadSave, parseSave } from "../../persistence/serialization";
import type { App } from "../app";
import { createBoardView } from "../boardRenderer";
import type { Board } from "../boardRenderer";
import { icon } from "../heraldry";
import { button, h, slider, toast } from "../dom";
import { createBotService, isTauri, saveSettings, saveStore } from "../platform";
import { HostedSession } from "../sessions";
import { gameScreen } from "./game";
import { labScreen } from "./lab";
import { multiplayerScreen } from "./multiplayer";
import { savesScreen } from "./saves";
import { setupScreen } from "./setup";

/** A small procedural landscape behind the menu (generated on the fly, different every day). */
function backdrop(app: App, canvas: HTMLCanvasElement): Board {
  const view = createBoardView(canvas, app.cache, app.settings.board3d);
  view.interactive = false;
  const s = createGame({ mode: "sandbox", deckSize: 0, params: { ...DEFAULT_DECK_PARAMS, cityDensity: 1.15 }, farmers: true, seed: "menu-" + new Date().toISOString().slice(0, 10), players: [{ id: "a", name: "", color: 0, kind: "bot" }, { id: "b", name: "", color: 1, kind: "bot" }] });
  // Enough tiles that the map covers the art area at any aspect, portrait phones included.
  for (let i = 0; i < 120 && s.phase === TurnPhase.PLACE_TILE; i++) {
    const ps = legalPlacements(s);
    // Grow compactly around the origin.
    ps.sort((p, q) => Math.hypot(p.x - 1, p.y) - Math.hypot(q.x - 1, q.y));
    applyUnchecked(s, { type: "PLACE_TILE", ...ps[0] });
    if ((s.phase as TurnPhase) === TurnPhase.PLACE_MEEPLE) applyUnchecked(s, { type: "SKIP_MEEPLE" });
  }
  view.setState(s);
  view.camera = { x: 190, y: 64, zoom: 1.15 };
  return view;
}

export function menuScreen(app: App) {
  const canvas = h("canvas");
  const view = backdrop(app, canvas);
  const cont = button("Continuer", async () => {
    try {
      const { rec, state } = loadSave(parseSave(await saveStore().read("autosave")));
      const session = new HostedSession(createBotService(() => app.settings.botDelay));
      session.host.resume(rec, state);
      session.useSides(app.settings.tableSides);
      app.show(gameScreen(session));
    } catch (e) { toast((e as Error).message, "error"); }
  });
  cont.disabled = true;
  saveStore().list().then((names) => { cont.disabled = !names.includes("autosave"); }, () => {});
  const el = h("div", { class: "menu" },
    h("div", { class: "menu-panel" },
      h("h1", null, "Bastides"),
      h("div", { class: "tag" }, "Bâtir un pays, tuile après tuile"),
      button("Nouvelle partie", () => app.show(setupScreen), "primary"),
      cont,
      button("Multijoueur", () => app.show(multiplayerScreen)),
      button("Historique et replays", () => app.show(savesScreen)),
      button("Générateur de tuiles", () => app.show(labScreen)),
      button("Paramètres", () => app.show(settingsScreen)),
      h("div", { class: "menu-foot muted small" }, "")),
    h("div", { class: "menu-art" }, canvas));
  return { el, dispose: () => view.destroy() };
}

export function settingsScreen(app: App) {
  const s = app.settings;
  const check = (label: string, key: "sound" | "autoCenter" | "showLegal" | "perf" | "board3d") =>
    h("label", null, h("input", { type: "checkbox", checked: s[key], onchange: (e: Event) => { s[key] = (e.target as HTMLInputElement).checked; saveSettings(s); } }), label);
  const delayOut = h("span", null, `${s.botDelay} ms`);
  const el = h("div", { class: "screen" }, h("div", { class: "screen-inner" },
    h("header", null, button([icon("back", 16), "Menu"], () => app.show(menuScreen)), h("h2", null, "Paramètres")),
    h("div", { class: "card col" },
      h("label", null, "Votre nom", h("input", { type: "text", value: s.name, maxLength: 24, oninput: (e: Event) => { s.name = (e.target as HTMLInputElement).value; saveSettings(s); } })),
      check("Sons synthétisés", "sound"),
      check("Centrer automatiquement la caméra sur la dernière tuile", "autoCenter"),
      check("Surligner les placements autorisés", "showLegal"),
      check("Plateau en 3D (relief, perspective et ombres)", "board3d"),
      check("Afficher les mesures de performance en jeu", "perf"),
      h("div", { class: "field" }, h("span", null, "Délai minimal des bots"), slider(0, 2000, 100, s.botDelay, (v) => { s.botDelay = v; delayOut.textContent = `${v} ms`; saveSettings(s); }), delayOut)),
    h("div", { class: "card" },
      h("h3", null, "Commandes"),
      h("p", null, "Glisser : déplacer la carte · Molette : zoom · Clic sur une case surlignée puis second clic ou Entrée : poser · R ou clic droit : tourner · Espace : passer le partisan · I : inspecter une région · F : tout voir · Échap : menu."))));
  return { el };
}
