/** In-game screen: board, players, current tile, turn actions, score log, region inspector. */
import { TILE_SIZE } from "../../core/types";
import type { FeatureKind } from "../../core/types";
import { generateGeometry, geometrySeedOf, rotatedAnchor } from "../../procedural/geometry/tileGeometry";
import { find, inspectRegion, legalPlacements, meepleOptions, ranking, tileTopology, tilesRemaining, topoIndex } from "../../game/gameEngine";
import type { Placement } from "../../game/gameEngine";
import { MEEPLES_PER_PLAYER, TurnPhase } from "../../game/state";
import type { GameState, ScoreEvent } from "../../game/state";
import { serializeSave, toSave } from "../../persistence/serialization";
import type { App } from "../app";
import { createBoardView } from "../boardRenderer";
import type { Board } from "../boardRenderer";
import type { Highlight } from "../boardRenderer";
import { PLAYER_COLORS, button, h, modal, replace, toast } from "../dom";
import { icon, shield } from "../heraldry";
import { attachBanner, setTitleBanner } from "../titlebar";
import { playSound, safeName, saveStore } from "../platform";
import type { GameSession } from "../sessions";
import { menuScreen } from "./menu";
import { replayScreen } from "./replay";

export const KIND_LABEL: Record<FeatureKind, string> = { city: "Cité", road: "Chemin", monastery: "Abbaye", field: "Prairie" };
const BLOCK_REASON = { occupied: "Cette région est déjà occupée par un partisan.", "no-meeple": "Vous n'avez plus de partisan disponible.", "farmers-disabled": "Les paysans sont désactivés dans cette partie.", "": "" };

/** Every (tile, feature) segment of the region containing (tileIndex, feature). */
export function regionHighlight(state: GameState, tileIndex: number, feature: number, color: string): Highlight {
  const node = find(state, state.tiles[tileIndex].base + feature);
  const features = new Map<number, Set<number>>();
  for (const ti of new Set(state.regions.get(node)!.tiles)) {
    const t = state.tiles[ti], n = topoIndex(tileTopology(t)).n;
    for (let f = 0; f < n; f++) if (find(state, t.base + f) === node) { if (!features.has(ti)) features.set(ti, new Set()); features.get(ti)!.add(f); }
  }
  return { features, color };
}

export function gameScreen(session: GameSession) {
  return (app: App) => {
    const players = session.state?.config.players ?? [];
    // Table mode: several humans share this screen and at least one sits elsewhere than the bottom.
    const sides = players.map((_, i) => session.tableSide(i));
    const tableMode = sides.filter((x) => x !== null).length >= 2 && sides.some((x) => x !== null && x !== 0);
    const stage = h("div", { class: "game-stage" });
    const canvas = h("canvas", { class: "board" });
    const view = createBoardView(canvas, app.cache, app.settings.board3d);
    const playersEl = h("div", { class: "panel players" });
    const logEl = h("div", { class: "log" });
    const tileCanvas = h("canvas", { width: 256, height: 256 });
    const countEl = h("div", { class: "count" });
    const statusEl = h("div", { class: "status" });
    const actionsEl = h("div", { class: "col" });
    const inspectEl = h("div", { class: "panel inspect", style: { display: "none" } });
    const perfEl = h("div", { class: "small muted mono" });

    let pending: Placement | null = null;
    let prefRot = 0;
    let legal: Placement[] = [];
    let seenLog = 0, seenRev = -1, seenTiles = 0;
    let inspecting = false;
    let overShown = false;
    let disposed = false;
    let lastSavedRev = -1;
    let focusedTurn = -1, focusTimer = 0;

    const state = () => session.state;
    const name = (i: number) => state()!.config.players[i].name;
    const color = (i: number) => PLAYER_COLORS[state()!.config.players[i].color];

    const act = (a: Parameters<GameSession["act"]>[0]) => {
      const err = session.act(a);
      if (err) toast(err, "error");
    };

    const rotate = () => {
      const s = state();
      if (!s || !s.current || !session.canAct() || s.phase !== TurnPhase.PLACE_TILE) return;
      if (pending) {
        const here = legal.filter((p) => p.x === pending!.x && p.y === pending!.y);
        const i = here.findIndex((p) => p.rotation === pending!.rotation);
        pending = here[(i + 1) % here.length];
        prefRot = pending.rotation;
      } else prefRot = (prefRot + 1) & 3;
      refresh();
    };
    const confirm = () => { if (pending) { const p = pending; pending = null; act({ type: "PLACE_TILE", ...p }); } };
    view.onRotate = rotate;

    view.onCellClick = (x, y, feature, tileIndex) => {
      const s = state();
      if (!s) return;
      if (inspecting || !session.canAct() || s.phase !== TurnPhase.PLACE_TILE) {
        if (tileIndex >= 0 && feature >= 0) showInspector(tileIndex, feature);
        else { view.setHighlight(null); inspectEl.style.display = "none"; }
        return;
      }
      const here = legal.filter((p) => p.x === x && p.y === y);
      if (!here.length) {
        if (tileIndex < 0 && s.frontier.size) toast(s.frontier.has((x + 32768) * 65536 + (y + 32768)) ? "Aucune orientation de cette tuile ne s'accorde avec les bordures voisines." : "Une tuile doit toucher une tuile déjà posée par un côté.");
        return;
      }
      if (pending && pending.x === x && pending.y === y) { confirm(); return; }
      pending = here.find((p) => p.rotation === prefRot) ?? here[0];
      refresh();
    };
    view.onSpotClick = (spot) => {
      if (spot.option.allowed) act({ type: "PLACE_MEEPLE", regionId: spot.option.regionId });
      else toast(BLOCK_REASON[spot.option.reason]);
    };

    function showInspector(tileIndex: number, feature: number): void {
      const s = state()!;
      const info = inspectRegion(s, tileIndex, feature);
      view.setHighlight(regionHighlight(s, tileIndex, feature, "#fff2a8"));
      const owners = info.meeples.map((n, i) => (n ? `${name(i)} ×${n}` : "")).filter(Boolean).join(", ") || "aucun";
      inspectEl.style.display = "";
      replace(inspectEl,
        h("div", { class: "row" }, h("h3", { class: "grow", style: { margin: "0" } }, `${KIND_LABEL[info.kind]} n°${info.node}`), Object.assign(button(icon("close", 16), () => { inspectEl.style.display = "none"; view.setHighlight(null); }, "small ghost icon-only"), { title: "Fermer", ariaLabel: "Fermer" })),
        h("dl", null,
          h("dt", null, "Tuiles"), h("dd", null, String(info.tiles.length)),
          info.kind === "road" || info.kind === "city" ? [h("dt", null, "Interfaces ouvertes"), h("dd", null, String(info.open))] : null,
          h("dt", null, "État"), h("dd", null, info.kind === "field" ? "évaluée en fin de partie" : info.closed ? (info.scored ? "terminée et comptée" : "terminée") : "en cours"),
          h("dt", null, "Propriétaires"), h("dd", null, owners),
          h("dt", null, "Majorité"), h("dd", null, info.winners.map(name).join(", ") || "—"),
          info.kind === "city" ? [h("dt", null, "Blasons"), h("dd", null, String(info.shields))] : null,
          h("dt", null, "Score actuel"), h("dd", null, info.closed || info.kind === "field" ? `${info.scoreNow} pts` : "0 (non terminée)"),
          h("dt", null, "Score potentiel"), h("dd", null, `${info.scoreFinal} pts en fin de partie (${info.reason})`),
          info.kind === "field" ? [h("dt", null, "Cités adjacentes"), h("dd", null, `${info.adjacentCities.filter((c) => c.closed).length} terminée(s) sur ${info.adjacentCities.length}`)] : null));
    }

    function describe(ev: ScoreEvent): string {
      const s = state()!;
      const who = ev.winningPlayerIds.map((id) => s.config.players.find((p) => p.id === id)?.name ?? id).join(" et ");
      return `${KIND_LABEL[ev.featureType]} — ${who} : ${ev.reason}`;
    }

    function drawPlayers(s: GameState): void {
      replace(playersEl, s.config.players.map((p, i) => {
        const ps = s.players[i];
       const active = s.player === i && s.phase !== TurnPhase.GAME_OVER;
        return h("div", { class: "player" + (active ? " active" : "") + (session.seatConnected(i) ? "" : " off") },
          shield(p.color, 26),
          h("div", null, h("div", { class: "name" }, p.name), h("div", { class: "sub" }, h("span", { class: "pips", title: `${ps.meeples} partisan(s) disponibles` }, Array.from({ length: MEEPLES_PER_PLAYER }, (_, k) => h("i", { class: k < ps.meeples ? "on" : "" }))), p.kind === "bot" ? " · bot" : "", active && session.status() ? " · " + session.status() : "")),
          h("div", { class: "score" }, String(ps.score)));
      }));
    }

    function drawTileBox(s: GameState): void {
      const ctx = tileCanvas.getContext("2d")!;
      ctx.clearRect(0, 0, 256, 256);
      if (s.current) ctx.drawImage(app.cache.get(s.current, pending ? pending.rotation : prefRot, 0, 0, 256) as CanvasImageSource, 0, 0);
      const rem = tilesRemaining(s);
      countEl.textContent = s.phase === TurnPhase.GAME_OVER ? "Partie terminée" : rem < 0 ? "Bac à sable — pioche infinie" : `${rem} tuile${rem > 1 ? "s" : ""} restante${rem > 1 ? "s" : ""}`;
    }

    function refresh(): void {
      const s = state();
      if (!s || disposed) return;
      const mine = session.canAct();
      if (tableMode && s.phase !== TurnPhase.GAME_OVER) {
        // Face the active human; during a bot's or a remote player's turn, stay as we are.
        const side = session.tableSide(s.player);
        if (side !== null) view.quarterTurns = side;
        stage.dataset.turn = String(view.quarterTurns);
      }
      // New turn or new revision: reset transient UI state.
      if (s.rev !== seenRev) {
        seenRev = s.rev;
        pending = null;
        legal = s.phase === TurnPhase.PLACE_TILE ? legalPlacements(s) : [];
        if (s.tiles.length !== seenTiles) {
          if (seenTiles) playSound("place", app.settings.sound);
          seenTiles = s.tiles.length;
          const t = s.tiles[s.tiles.length - 1];
          if (app.settings.autoCenter && view.isOffCentre(t.x, t.y)) view.centerOn(t.x, t.y);
        }
        if (inspectEl.style.display !== "none") { inspectEl.style.display = "none"; view.setHighlight(null); }
        focusOwnTurn(s, mine);
        autosave(s);
      }
      // Score events since the last refresh: pop-ups, sound, log.
      if (s.log.length > seenLog) {
        for (const ev of s.log.slice(seenLog)) {
          const t = s.tiles[ev.tiles[ev.tiles.length - 1]];
          const w = s.config.players.findIndex((p) => p.id === ev.winningPlayerIds[0]);
          if (!ev.final) view.addPopup(t.x, t.y, "+" + ev.points, w >= 0 ? color(w) : "#fff");
          const entry = h("div", { class: "entry", title: "Cliquer pour localiser", onclick: () => { view.centerOn(t.x, t.y); showByNode(ev); } },
            ev.winningPlayerIds.map((id) => shield(s.config.players.find((p) => p.id === id)?.color ?? 0, 15)),
            h("b", null, `+${ev.points} `), describe(ev));
          logEl.prepend(entry);
        }
        if (seenLog || s.log.some((e) => !e.final)) playSound("score", app.settings.sound);
        seenLog = s.log.length;
      }
      view.setState(s);
      view.showLegal = app.settings.showLegal;
      view.lastTile = s.tiles.length > 1 ? s.tiles.length - 1 : -1;
      view.legalCells = mine && s.phase === TurnPhase.PLACE_TILE && !inspecting ? uniqueCells(legal) : [];
      view.ghost = pending && s.current ? { def: s.current, ...pending, legal: true } : null;
      view.spots = [];
      if (s.phase === TurnPhase.PLACE_MEEPLE && mine) {
        const t = s.tiles[s.lastTile];
        const g = generateGeometry(t.def.topologyId, geometrySeedOf(t.def.seed));
        view.spots = meepleOptions(s).map((option) => { const a = rotatedAnchor(g, t.rotation, option.regionId); return { option, x: t.x * TILE_SIZE + a.x, y: t.y * TILE_SIZE + a.y }; });
      }
      drawPlayers(s);
      drawTileBox(s);
      // Status and actions.
      const who = h("b", { class: "who" }, shield(s.config.players[s.player].color, 16), name(s.player));
      if (s.phase === TurnPhase.GAME_OVER) replace(statusEl, "La partie est terminée.");
      else if (s.phase === TurnPhase.DRAW_TILE) replace(statusEl, "En attente de la prochaine tuile…");
      else if (!mine) replace(statusEl, who, s.config.players[s.player].kind === "bot" ? " réfléchit…" : " joue…", session.status() ? h("div", { class: "muted small" }, session.status()) : null);
      else if (s.phase === TurnPhase.PLACE_TILE) replace(statusEl, who, pending ? " : confirmez ou tournez la tuile." : legal.length ? " : choisissez une case surlignée." : "");
      else replace(statusEl, who, " : posez un partisan sur une région libre, ou passez.");
      statusEl.classList.toggle("pending", s.phase === TurnPhase.DRAW_TILE || (!mine && s.phase !== TurnPhase.GAME_OVER));
      setTitleBanner(s.phase === TurnPhase.GAME_OVER ? null : h("span", { class: "tb-turn" }, shield(s.config.players[s.player].color, 18), h("b", null, name(s.player)), h("span", null, mine ? "à vous de jouer" : s.config.players[s.player].kind === "bot" ? "réfléchit…" : "joue…")));
      const placing = mine && s.phase === TurnPhase.PLACE_TILE;
      replace(actionsEl,
        h("div", { class: "row" }, Object.assign(button([icon("rotate", 17), "Tourner"], rotate, "grow"), { disabled: !placing, title: "Touche R ou clic droit" })),
        placing ? Object.assign(button("Poser la tuile", confirm, "primary"), { disabled: !pending, title: "Entrée" }) : null,
        mine && s.phase === TurnPhase.PLACE_MEEPLE ? button("Passer (aucun partisan)", () => act({ type: "SKIP_MEEPLE" }), "primary") : null,
        mine && placing && s.config.mode === "sandbox" ? button("Terminer et compter", () => act({ type: "END_GAME" })) : null);
      if (s.phase === TurnPhase.GAME_OVER && !overShown) { overShown = true; playSound("end", app.settings.sound); showResults(); }
      view.requestRender();
    }

    /**
     * At the start of a turn played here, bring the camera back to where this player last
     * built. When an opponent has just laid a tile, show it first, then travel home.
     */
    function focusOwnTurn(s: GameState, mine: boolean): void {
      if (!app.settings.autoCenter || !mine || s.phase !== TurnPhase.PLACE_TILE || focusedTurn === s.tiles.length) return;
      focusedTurn = s.tiles.length;
      clearTimeout(focusTimer);
      let own = -1;
      for (let i = s.tiles.length - 1; i >= 0; i--) if (s.tiles[i].by === s.player) { own = i; break; }
      if (own < 0) return; // first turn: nothing of ours on the board yet
      const t = s.tiles[own], latest = s.tiles[s.tiles.length - 1];
      const go = () => { if (!disposed && !pending && state() === s && session.canAct()) view.centerOn(t.x, t.y); };
      if (latest.by !== s.player && latest !== t && seenTiles > 1) focusTimer = window.setTimeout(go, 900);
      else go();
    }

    function showByNode(ev: ScoreEvent): void {
      const s = state()!;
      const features = new Map<number, Set<number>>();
      for (const ti of ev.tiles) {
        const t = s.tiles[ti], n = topoIndex(tileTopology(t)).n;
        for (let f = 0; f < n; f++) if (find(s, t.base + f) === find(s, ev.node)) { if (!features.has(ti)) features.set(ti, new Set()); features.get(ti)!.add(f); }
      }
      view.setHighlight({ features, color: "#fff2a8" });
    }

    function uniqueCells(ps: Placement[]): { x: number; y: number }[] {
      const seen = new Set<string>(), out: { x: number; y: number }[] = [];
      for (const p of ps) { const k = p.x + "," + p.y; if (!seen.has(k)) { seen.add(k); out.push({ x: p.x, y: p.y }); } }
      return out;
    }

    function autosave(s: GameState): void {
      if (session.kind !== "local" || s.rev === lastSavedRev || s.rev === 0) return;
      if (s.phase !== TurnPhase.PLACE_TILE && s.phase !== TurnPhase.GAME_OVER) return;
      const rec = session.recording();
      if (!rec) return;
      lastSavedRev = s.rev;
      void saveStore().write("autosave", serializeSave(toSave(rec, s, "Sauvegarde automatique", new Date().toISOString()))).catch(() => {});
    }

    function saveDialog(): void {
      const s = state(), rec = session.recording();
      if (!s || !rec) return;
      const input = h("input", { type: "text", value: "partie-" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"), style: { width: "100%" } });
      const m = modal("Sauvegarder la partie", h("div", { class: "col" }, h("p", null, session.kind === "client" ? "En tant qu'invité, seule la partie publique (tuiles révélées et actions) est enregistrée : elle peut être rejouée mais pas reprise." : "La sauvegarde contient les paramètres, le deck et l'historique des actions — aucune image."), input),
        [button("Annuler", () => m.close()), button("Sauvegarder", () => {
          const nm = safeName(input.value);
          saveStore().write(nm, serializeSave(toSave(rec, s, input.value, new Date().toISOString()))).then(() => toast(`Partie enregistrée : ${nm}`), (e) => toast(String(e), "error"));
          m.close();
        }, "primary")], () => {}, tableMode ? el : undefined);
      input.select();
    }

    function showResults(): void {
      const s = state()!;
      const rank = ranking(s);
      const best = [...s.log].sort((a, b) => b.points - a.points).slice(0, 4);
      const audit = session.audit();
      const body = h("div", { class: "col" },
        h("table", null,
          h("tr", null, ["Joueur", "Total", "En jeu", "Final", "Cités", "Chemins", "Abbayes", "Prairies", "Tuiles", "Partisans posés"].map((x) => h("th", null, x))),
          rank.map((r) => { const p = s.players[r.player]; return h("tr", null,
            h("td", null, `${r.rank}. `, shield(s.config.players[r.player].color, 16), " ", name(r.player)),
            [p.score, p.duringGame, p.final, p.byKind.city, p.byKind.road, p.byKind.monastery, p.byKind.field, p.tilesPlaced, p.meeplesPlaced].map((v, i) => h("td", null, i === 0 ? h("b", null, String(v)) : String(v)))); })),
        rank.filter((r) => r.rank === 1).length > 1 ? h("p", { class: "muted" }, "Égalité au premier rang : la victoire est partagée.") : null,
        h("h3", null, "Principales régions"),
        best.length ? best.map((ev) => h("div", { class: "small" }, h("b", null, `${ev.points} pts `), describe(ev))) : h("div", { class: "muted small" }, "Aucune région marquée."),
        h("p", { class: "muted small" }, `${s.tiles.length} tuiles posées, ${s.discarded.length} défaussée(s). Graine publique : `, h("span", { class: "mono" }, s.config.seed)),
        audit ? h("p", { class: audit.status === "failed" ? "err" : audit.status === "verified" ? "ok" : "muted" }, audit.status === "verified" ? [icon("check", 16), " Deck vérifié : il correspond à l'engagement publié par l'hôte avant la partie."] : audit.status === "failed" ? [icon("close", 16), " Vérification du deck échouée : " + audit.reason] : "Vérification du deck en attente de la révélation de l'hôte…") : null);
      const m = modal("Fin de la partie", body, [
        button("Voir le plateau", () => m.close()),
        button("Sauvegarder", saveDialog),
        button("Revoir la partie", () => { const rec = session.recording(); if (rec) { m.close(); leave(); app.show(replayScreen({ ...rec, actions: rec.actions.slice() })); } }),
        button("Menu principal", () => { m.close(); quit(); }, "primary"),
      ], undefined, tableMode ? el : undefined);
    }

    const leave = () => { disposed = true; session.onChange = null; session.leave(); };
    const quit = () => { leave(); app.show(menuScreen); };
    const menu = () => {
      const m = modal("Menu", h("p", null, session.kind === "local" ? "La partie est sauvegardée automatiquement à chaque tour." : session.kind === "host" ? "Quitter met fin à la partie pour tous les joueurs." : "Vous pourrez vous reconnecter tant que l'hôte garde la partie ouverte."), [
        button("Reprendre", () => m.close()), button("Sauvegarder…", () => { m.close(); saveDialog(); }), button("Quitter la partie", () => { m.close(); quit(); }, "primary")], () => {}, tableMode ? el : undefined);
    };

    const inspectBtn = button([icon("inspect", 16), "Inspecter"], () => { inspecting = !inspecting; inspectBtn.classList.toggle("primary", inspecting); if (!inspecting) { view.setHighlight(null); inspectEl.style.display = "none"; } refresh(); toast(inspecting ? "Inspection : cliquez sur une cité, un chemin ou une prairie." : "Inspection désactivée."); });
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || document.querySelector(".modal-wrap")) return;
      const s = state();
      if (e.key === "r" || e.key === "R") rotate();
      else if (e.key === "Enter" && pending) confirm();
      else if (e.key === " " && s?.phase === TurnPhase.PLACE_MEEPLE && session.canAct()) { e.preventDefault(); act({ type: "SKIP_MEEPLE" }); }
      else if (e.key === "Escape") { if (pending) { pending = null; refresh(); } else menu(); }
      else if (e.key === "i" || e.key === "I") inspectBtn.click();
      else if (e.key === "f" || e.key === "F") view.fit();
    };
    window.addEventListener("keydown", onKey);
    let perfTimer = 0;
    if (app.settings.perf) perfTimer = window.setInterval(() => { perfEl.textContent = `${view.stats.frameMs.toFixed(1)} ms · ${view.stats.drawn} tuiles · cache ${app.cache.size} (${(app.cache.memoryBytes / 1048576).toFixed(0)} Mo)`; }, 500);

    session.onChange = refresh;
    const el = h("div", { class: "game" }, canvas,
      h("div", { class: "hud left" }, playersEl, h("div", { class: "panel logwrap" }, h("h3", { class: "hud-title" }, "Points marqués"), logEl)),
      h("div", { class: "hud right" },
        h("div", { class: "panel tilebox" }, tileCanvas, countEl),
        h("div", { class: "panel col" }, statusEl, actionsEl),
        h("div", { class: "panel tools" }, button([icon("centre", 16), "Centrer"], () => { const s = state(); if (s) { const t = s.tiles[s.tiles.length - 1]; view.centerOn(t.x, t.y); } }), button([icon("fit", 16), "Tout voir"], () => view.fit()), inspectBtn, button([icon("menu", 16), "Menu"], menu), perfEl)),
      inspectEl);
    stage.appendChild(el);
    const detachBanner = attachBanner(el, tableMode);
    queueMicrotask(refresh);
    return { el: stage, dispose: () => { clearTimeout(focusTimer); detachBanner(); window.removeEventListener("keydown", onKey); clearInterval(perfTimer); view.destroy(); if (!disposed) leave(); } };
  };
}
