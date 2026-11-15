import { randomSeedString } from "../../core/random";
import { DEFAULT_DECK_PARAMS } from "../../game/state";
import type { BotLevel, DeckParams, GameMode } from "../../game/state";
import type { LobbySettings } from "../../multiplayer/protocol";
import type { App } from "../app";
import { PLAYER_COLOR_NAMES, button, h, replace, select, slider, toast } from "../dom";
import { icon, shield } from "../heraldry";
import { createBotService, saveSettings } from "../platform";
import { HostedSession } from "../sessions";
import type { TableSide } from "../sessions";
import { tableSidePicker } from "../tableSide";
import { gameScreen } from "./game";
import { menuScreen } from "./menu";

export const LEVELS: [BotLevel, string][] = [["easy", "Facile"], ["normal", "Normal"], ["hard", "Difficile"], ["expert", "Expert"]];
export const MODES: [GameMode, string][] = [["classic", "Classique — 72 tuiles"], ["procedural", "Procédural — deck original"], ["sandbox", "Bac à sable — sans limite"]];
const PARAMS: [keyof DeckParams, string][] = [
  ["cityDensity", "Densité de cités"], ["roadDensity", "Densité de chemins"], ["grassDensity", "Densité de prairies"],
  ["monasteryFreq", "Fréquence des abbayes"], ["shieldFreq", "Fréquence des blasons"], ["junctionFreq", "Fréquence des carrefours"],
  ["throughCityFreq", "Cités traversantes"], ["complexity", "Complexité topologique"], ["diversity", "Diversité des configurations"],
];

/** Mode, deck size, generation parameters and farmers: shared by local set-up and network lobby. */
export function settingsEditor(settings: LobbySettings, onChange: () => void, editable = true): HTMLElement {
  const box = h("div", { class: "col" });
  const draw = () => {
    const sizeOut = h("span", null, String(settings.deckSize));
    replace(box,
      h("div", { class: "field" }, h("span", null, "Mode"), Object.assign(select(MODES, settings.mode, (v) => { settings.mode = v; if (v === "classic") settings.deckSize = 72; onChange(); draw(); }), { disabled: !editable }), h("span")),
      settings.mode === "procedural" ? h("div", { class: "field" }, h("span", null, "Taille du deck"), Object.assign(slider(24, 240, 4, settings.deckSize, (v) => { settings.deckSize = v; sizeOut.textContent = String(v); onChange(); }), { disabled: !editable }), sizeOut) : null,
      h("label", null, h("input", { type: "checkbox", checked: settings.farmers, disabled: !editable, onchange: (e: Event) => { settings.farmers = (e.target as HTMLInputElement).checked; onChange(); } }), "Paysans (partisans dans les prairies)"),
      settings.mode !== "classic" ? h("details", null, h("summary", null, "Paramètres de génération"), h("div", { style: { marginTop: "8px" } },
        PARAMS.map(([key, label]) => { const out = h("span", null, settings.params[key].toFixed(1)); return h("div", { class: "field" }, h("span", null, label), Object.assign(slider(0, 2.5, 0.1, settings.params[key], (v) => { settings.params = { ...settings.params, [key]: v }; out.textContent = v.toFixed(1); onChange(); }), { disabled: !editable }), out); }),
        editable ? button("Valeurs par défaut", () => { settings.params = { ...DEFAULT_DECK_PARAMS }; onChange(); draw(); }, "small") : null)) : null);
  };
  draw();
  return box;
}

interface SeatDraft { kind: "human" | "bot"; name: string; level: BotLevel; color: number; side: TableSide }

export function setupScreen(app: App) {
  const remembered = (i: number): TableSide => ((app.settings.tableSides[i] ?? 0) & 3) as TableSide;
  const seats: SeatDraft[] = [
    { kind: "human", name: app.settings.name || "Joueur", level: "normal", color: 0, side: remembered(0) },
    { kind: "bot", name: "Bot Difficile", level: "hard", color: 1, side: remembered(1) },
  ];
  const humans = () => seats.filter((s) => s.kind === "human").length;
  const rememberSides = () => { app.settings.tableSides = seats.map((s) => s.side); saveSettings(app.settings); };
  const settings: LobbySettings = { mode: "classic", deckSize: 72, params: { ...DEFAULT_DECK_PARAMS }, farmers: true, replaceAbsent: true };
  const seatsEl = h("div", { class: "col" });
  const tableNote = h("p", { class: "muted small table-note" }, "Plusieurs humains sur cet écran : indiquez de quel côté chacun s'assoit, le plateau pivote vers le joueur actif. Tous en bas : pas de rotation.");
  const seedInput = h("input", { type: "text", placeholder: "aléatoire", maxLength: 64, style: { width: "260px" } });
  const botName = (l: BotLevel) => "Bot " + LEVELS.find((x) => x[0] === l)![1];
  const draw = () => {
    const table = humans() >= 2;
    tableNote.hidden = !table;
    replace(seatsEl, seats.map((s, i) => h("div", { class: "row" },
      shield(s.color, 26),
      select<"human" | "bot">([["human", "Humain"], ["bot", "Bot"]], s.kind, (v) => { s.kind = v; s.name = v === "bot" ? botName(s.level) : `Joueur ${i + 1}`; if (v === "human") s.side = remembered(i); draw(); }),
      h("input", { type: "text", value: s.name, maxLength: 24, class: "grow", oninput: (e: Event) => { s.name = (e.target as HTMLInputElement).value; } }),
      s.kind === "bot" ? select(LEVELS, s.level, (v) => { if (s.name === botName(s.level)) s.name = botName(v); s.level = v; draw(); }) : null,
      select(PLAYER_COLOR_NAMES.map((n, c) => [String(c), n] as [string, string]), String(s.color), (v) => { const c = Number(v), other = seats.find((o) => o !== s && o.color === c); if (other) other.color = s.color; s.color = c; draw(); }),
      table && s.kind === "human" ? tableSidePicker(s.side, (side) => { s.side = side; rememberSides(); }, s.name) : table ? h("span", { class: "table-side", "aria-hidden": "true" }) : null,
      Object.assign(button("Retirer", () => { seats.splice(i, 1); draw(); }, "small"), { disabled: seats.length <= 2 }))),
      Object.assign(button([icon("plus", 15), "Ajouter un joueur"], () => { const c = [0, 1, 2, 3, 4, 5, 6, 7].find((x) => !seats.some((s) => s.color === x))!; seats.push({ kind: "bot", name: botName("normal"), level: "normal", color: c, side: remembered(seats.length) }); draw(); }, "small"), { disabled: seats.length >= 5 }));
  };
  draw();
  const start = () => {
    const session = new HostedSession(createBotService(() => app.settings.botDelay));
    session.host.updateSettings(settings);
    for (const s of seats) {
      const id = s.kind === "bot" ? session.host.addBot(s.level, s.name || botName(s.level)) : session.host.addLocalPlayer(s.name || "Joueur");
      if (id) session.host.updateSeat(id, { color: s.color });
    }
    // Colours may have been swapped while seats were being added: apply them again.
    session.host.seats.forEach((seat, i) => { seat.color = seats[i].color; });
    session.host.seats.forEach((seat, i) => { if (seats[i].kind === "human") session.sides.set(seat.id, seats[i].side); });
    rememberSides();
    const err = session.host.start(seedInput.value.trim() || randomSeedString(8));
    if (err) { toast(err, "error"); session.leave(); return; }
    app.show(gameScreen(session));
  };
  const el = h("div", { class: "screen" }, h("div", { class: "screen-inner" },
    h("header", null, button([icon("back", 16), "Menu"], () => app.show(menuScreen)), h("h2", null, "Nouvelle partie"), button("Commencer", start, "primary")),
    h("div", { class: "card" }, h("h3", null, "Joueurs (2 à 5)"), seatsEl, tableNote, h("p", { class: "muted small", style: { marginTop: "10px" } }, "Plusieurs humains jouent à tour de rôle sur cette machine. Un humain contre des bots constitue une partie solo, entièrement hors ligne.")),
    h("div", { class: "card" }, h("h3", null, "Règles et deck"), settingsEditor(settings, () => {}),
      h("div", { class: "field", style: { marginTop: "8px" } }, h("span", null, "Graine (optionnelle)"), seedInput, h("span")),
      h("p", { class: "muted small" }, "Une même graine avec les mêmes réglages reproduit exactement le même deck : elle peut être partagée."))));
  return { el };
}
