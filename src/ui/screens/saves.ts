import { loadSave, parseSave, recordingOf } from "../../persistence/serialization";
import type { SaveFile } from "../../persistence/serialization";
import type { App } from "../app";
import { button, h, modal, replace, toast } from "../dom";
import { icon } from "../heraldry";
import { createBotService, safeName, saveStore } from "../platform";
import { HostedSession } from "../sessions";
import { gameScreen } from "./game";
import { menuScreen } from "./menu";
import { replayScreen } from "./replay";

const MODE = { classic: "Classique", procedural: "Procédural", sandbox: "Bac à sable" };

export function savesScreen(app: App) {
  const store = saveStore();
  const list = h("div", { class: "col" });

  const load = async () => {
    replace(list, h("div", { class: "muted" }, "Chargement…"));
    let names: string[] = [];
    try { names = await store.list(); } catch (e) { replace(list, h("div", { class: "err" }, String(e))); return; }
    if (!names.length) { replace(list, h("div", { class: "card muted" }, "Aucune partie enregistrée pour l'instant. Les parties locales sont sauvegardées automatiquement.")); return; }
    const rows: HTMLElement[] = [];
    for (const name of names) {
      let save: SaveFile | null = null, error = "";
      let text = "";
      try { text = await store.read(name); save = parseSave(text); } catch (e) { error = (e as Error).message; }
      const resumable = !!save && save.summary.phase !== "GAME_OVER" && (save.total < 0 ? save.secret !== undefined : save.deck.length === save.total);
      rows.push(h("div", { class: "card row" },
        h("div", { class: "grow" },
          h("div", null, h("b", null, save?.name || name), " ", h("span", { class: "muted small mono" }, name)),
          save ? h("div", { class: "small muted" }, `${MODE[save.config.mode]} · ${save.config.players.map((p, i) => `${p.name} ${save!.summary.scores[i] ?? 0}`).join(" — ")} · ${save.summary.tiles} tuiles · ${save.summary.phase === "GAME_OVER" ? "terminée" : "en cours"} · ${save.savedAt.slice(0, 16).replace("T", " ")} · ${(text.length / 1024).toFixed(1)} Ko`) : h("div", { class: "small err" }, error)),
        save && resumable ? button("Reprendre", () => {
          try {
            const { rec, state } = loadSave(save!);
            const session = new HostedSession(createBotService(() => app.settings.botDelay));
            session.host.resume(rec, state);
            app.show(gameScreen(session));
          } catch (e) { toast((e as Error).message, "error"); }
        }, "primary small") : null,
        save ? button("Replay", () => { try { loadSave(save!); app.show(replayScreen(recordingOf(save!))); } catch (e) { toast((e as Error).message, "error"); } }, "small") : null,
        save ? button("Exporter", () => exportDialog(name, text), "small") : null,
        button("Supprimer", () => { const m = modal("Supprimer la sauvegarde ?", h("p", null, `« ${name} » sera définitivement supprimée.`), [button("Annuler", () => m.close()), button("Supprimer", () => { m.close(); void store.remove(name).then(load); }, "primary")], () => {}); }, "small")));
    }
    replace(list, rows);
  };

  const exportDialog = (name: string, text: string) => {
    const area = h("textarea", { rows: 9, readOnly: true, value: text });
    const m = modal("Exporter la partie", h("div", { class: "col" }, h("p", null, "Le fichier ne contient que des données logiques (paramètres, deck, actions)."), area), [
      button("Copier", () => { void navigator.clipboard?.writeText(text).then(() => toast("Copié dans le presse-papiers."), () => { area.select(); toast("Sélectionné : copiez avec Ctrl+C."); }); }),
      button("Télécharger", () => { const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: name + ".bastides.json" }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }),
      button("Fermer", () => m.close(), "primary")], () => {});
  };

  const importText = async (text: string, hint: string) => {
    try {
      const save = parseSave(text);
      loadSave(save); // full verification by replay before accepting the file
      const name = safeName(save.name || hint || "import");
      await store.write(name, text);
      toast(`Partie importée : ${name}`);
      void load();
    } catch (e) { toast((e as Error).message, "error"); }
  };
  const file = h("input", { type: "file", accept: ".json,application/json", style: { display: "none" }, onchange: async () => { const f = file.files?.[0]; if (f) { if (f.size > 4 * 1024 * 1024) toast("Fichier trop volumineux.", "error"); else await importText(await f.text(), f.name.replace(/\..*$/, "")); file.value = ""; } } });
  const importDialog = () => {
    const area = h("textarea", { rows: 9, placeholder: "Collez ici le contenu d'une partie exportée…" });
    const m = modal("Importer une partie", h("div", { class: "col" }, area), [button("Choisir un fichier…", () => { m.close(); file.click(); }), button("Annuler", () => m.close()), button("Importer", () => { m.close(); void importText(area.value, "import"); }, "primary")], () => {});
  };

  void load();
  const el = h("div", { class: "screen" }, h("div", { class: "screen-inner" },
    h("header", null, button([icon("back", 16), "Menu"], () => app.show(menuScreen)), h("h2", null, "Historique et replays"), button("Importer…", importDialog), file),
    list));
  return { el };
}
