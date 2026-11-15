import { TurnPhase } from "../../game/state";
import { ReplayPlayer } from "../../persistence/replay";
import type { Recording } from "../../persistence/serialization";
import type { App } from "../app";
import { BoardView } from "../boardRenderer";
import { button, h, replace, select, toast } from "../dom";
import { icon, shield } from "../heraldry";
import type { IconName } from "../heraldry";
import { savesScreen } from "./saves";

const iconBtn = (name: IconName, label: string, run: () => void) =>
  Object.assign(button(icon(name, 18), run, "small icon-only"), { title: label, ariaLabel: label });

/** Deterministic replay: the recorded actions are re-applied by the engine, step by step. */
export function replayScreen(rec: Recording) {
  return (app: App) => {
    let player: ReplayPlayer;
    try { player = new ReplayPlayer(rec); } catch (e) { toast((e as Error).message, "error"); return savesScreen(app); }
    const canvas = h("canvas", { class: "board" });
    const view = new BoardView(canvas, app.cache);
    view.interactive = false;
    const range = h("input", { type: "range", min: 0, max: player.length, step: 1, value: 0, class: "grow", "aria-label": "Position dans la partie", oninput: () => go(Number(range.value)) });
    const label = h("span", { class: "small replay-pos" });
    const scores = h("div", { class: "panel players replay-scores" });
    let timer = 0, speed = 1, lastTiles = 0;
    const go = (n: number) => {
      let s;
      try { s = player.seek(n); } catch (e) { toast((e as Error).message, "error"); stop(); return; }
      range.value = String(player.position);
      label.textContent = `${player.position} / ${player.length}`;
      view.setState(s);
      view.lastTile = s.tiles.length > 1 ? s.tiles.length - 1 : -1;
      if (s.tiles.length !== lastTiles) { lastTiles = s.tiles.length; const t = s.tiles[s.tiles.length - 1]; if (view.isOffCentre(t.x, t.y)) view.centerOn(t.x, t.y); }
      replace(scores, s.config.players.map((p, i) => h("div", { class: "player" + (s.player === i && s.phase !== TurnPhase.GAME_OVER ? " active" : "") },
        shield(p.color, 22), h("div", { class: "name" }, p.name), h("div", { class: "score" }, String(s.players[i].score)))));
    };
    const setPlay = (playing: boolean) => replace(playBtn, icon(playing ? "pause" : "play", 17), playing ? "Pause" : "Lecture");
    const stop = () => { clearInterval(timer); timer = 0; setPlay(false); };
    const play = () => {
      if (timer) return stop();
      if (player.position >= player.length) go(0);
      setPlay(true);
      timer = window.setInterval(() => { if (player.position >= player.length) stop(); else go(player.position + 1); }, 700 / speed);
    };
    const playBtn = button([icon("play", 17), "Lecture"], play, "primary");
    const bar = h("div", { class: "panel replaybar" },
      iconBtn("first", "Début", () => { stop(); go(0); }), iconBtn("prev", "Action précédente", () => { stop(); go(player.position - 1); }), playBtn,
      iconBtn("next", "Action suivante", () => { stop(); go(player.position + 1); }), iconBtn("last", "Fin", () => { stop(); go(player.length); }),
      range, label,
      select([["1", "×1"], ["2", "×2"], ["4", "×4"], ["8", "×8"], ["16", "×16"]], "1", (v) => { speed = Number(v); if (timer) { stop(); play(); } }),
      button("Fermer", () => app.show(savesScreen), "small"));
    const el = h("div", { class: "game" }, canvas, scores, bar);
    queueMicrotask(() => go(0));
    return { el, dispose: () => { clearInterval(timer); view.destroy(); } };
  };
}
