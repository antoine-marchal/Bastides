/** Network play: host a lobby in the app or join one by address / room code. */
import { decodeRoomCode, encodeRoomCode } from "../../multiplayer/protocol";
import type { LobbySettings, SeatInfo } from "../../multiplayer/protocol";
import type { App } from "../app";
import { PLAYER_COLOR_NAMES, button, h, replace, select, toast } from "../dom";
import { icon, shield } from "../heraldry";
import { createBotService, isTauri, prepareNetwork, saveSettings, startNetServer } from "../platform";
import { HostedSession, RemoteSession } from "../sessions";
import { gameScreen } from "./game";
import { menuScreen } from "./menu";
import { LEVELS, settingsEditor } from "./setup";

const DEFAULT_PORT = 41234;

function seatRow(s: SeatInfo, extra: (HTMLElement | null)[] = []): HTMLElement {
  const waiting = s.kind !== "bot" && !s.local && !s.connected;
  return h("div", { class: "row seat" + (waiting ? " pending" : ""), style: { padding: "4px 6px" } },
    shield(s.color, 22),
    h("b", { class: "grow" }, s.name), h("span", { class: "muted small" }, s.kind === "bot" ? "bot " + (LEVELS.find((l) => l[0] === s.level)?.[1] ?? "") : s.local ? "sur l'hôte" : s.connected ? "connecté" : "déconnecté"),
    h("span", { class: s.ready ? "ok" : "muted" }, s.ready ? [icon("check", 15), " prêt"] : "pas encore prêt"), extra);
}

export function multiplayerScreen(app: App) {
  const body = h("div", { class: "col" });
  let cleanup: (() => void) | null = null;
  let busy = false, disposed = false;
  const nameInput = h("input", { type: "text", value: app.settings.name, maxLength: 24, oninput: () => { app.settings.name = nameInput.value; saveSettings(app.settings); } });

  // ------------------------------------------------------------------ host
  const hostLobby = async (port: number) => {
    if (busy) return;
    busy = true;
    const session = new HostedSession(createBotService(() => app.settings.botDelay));
    try {
      session.server = await startNetServer(port, {
        open: (c) => session.host.onConnect(c), message: (c, t) => session.host.onMessage(c, t), close: (c) => session.host.onDisconnect(c),
      });
    } catch (e) {
      if (!disposed) toast(String((e as Error).message ?? e), "error");
      session.leave();
      return;
    } finally { busy = false; }
    if (disposed) { session.leave(); return; }
    session.host.addLocalPlayer(nameInput.value || "Hôte");
    let started = false;
    cleanup = () => { if (!started) session.leave(); };
    const seatsEl = h("div"), startBtn = button("Démarrer la partie", () => {
      const err = session.host.start();
      if (err) return toast(err, "error");
      started = true;
      app.show(gameScreen(session));
    }, "primary");
    const settings: LobbySettings = { ...session.host.settings };
    const draw = () => {
      replace(seatsEl, session.host.seatInfos().map((s, i) => seatRow(s, [i > 0 ? button("Retirer", () => session.host.removeSeat(s.id), "small") : null])));
      startBtn.disabled = !!session.host.canStart();
      startBtn.title = session.host.canStart();
    };
    session.onChange = draw;
    const srv = session.server!;
    const lan = srv.addresses.filter((a) => a !== "127.0.0.1");
    replace(body,
      h("div", { class: "card" }, h("h3", null, "Votre salon"),
        lan.length ? lan.map((a) => h("div", { class: "row" }, h("span", null, "Adresse : "), h("b", { class: "mono" }, `${a}:${srv.port}`), h("span", null, " · code : "), h("b", { class: "mono" }, encodeRoomCode(a, srv.port)))) : h("div", { class: "err" }, "Aucune interface réseau locale détectée."),
        h("p", { class: "muted small", style: { marginTop: "8px" } }, "Les joueurs du même réseau local se connectent avec l'adresse ou le code. Pour un joueur distant, l'hôte doit être joignable (redirection du port TCP ", String(srv.port), " sur la box, VPN ou tunnel) : le code n'est qu'une écriture compacte de l'adresse, pas un service de mise en relation.")),
      h("div", { class: "card" }, h("h3", null, "Joueurs"), seatsEl,
        h("div", { class: "row", style: { marginTop: "8px" } }, LEVELS.map(([lvl, label]) => button([icon("plus", 15), "Bot " + label], () => { if (!session.host.addBot(lvl)) toast("La partie est complète.", "error"); }, "small")), button([icon("plus", 15), "Joueur local"], () => { if (!session.host.addLocalPlayer("Joueur local")) toast("La partie est complète.", "error"); }, "small"))),
      h("div", { class: "card" }, h("h3", null, "Réglages"), settingsEditor(settings, () => session.host.updateSettings({ ...settings })),
        h("label", null, h("input", { type: "checkbox", checked: settings.replaceAbsent, onchange: (e: Event) => { settings.replaceAbsent = (e.target as HTMLInputElement).checked; session.host.updateSettings({ ...settings }); } }), "Remplacer un joueur déconnecté par un bot pendant son absence")),
      h("div", { class: "row" }, startBtn, button("Fermer le salon", () => { cleanup?.(); cleanup = null; home(); })));
    draw();
  };

  // ------------------------------------------------------------------ join
  const joinLobby = async (address: string) => {
    if (busy) return;
    let target = address.trim();
    const code = decodeRoomCode(target);
    if (code && !target.includes(".") && !target.includes(":")) target = `${code.ip}:${code.port}`;
    if (!/^[\w.\-\[\]:]+$/.test(target)) return toast("Adresse ou code invalide.", "error");
    if (!/:\d+$/.test(target)) target += ":" + DEFAULT_PORT;
    busy = true;
    try { await prepareNetwork(); }
    catch (e) {
      if (!disposed) toast(String((e as Error).message ?? e), "error");
      return;
    } finally { busy = false; }
    if (disposed) return;
    const session = new RemoteSession("ws://" + target, nameInput.value || "Invité");
    let started = false, ready = false;
    cleanup = () => { if (!started) session.leave(); };
    const box = h("div", { class: "col" });
    const draw = () => {
      const c = session.client;
      if (c.state && !started) { started = true; app.show(gameScreen(session)); return; }
      if (c.error) { replace(box, h("div", { class: "card err" }, c.error), button("Retour", () => { cleanup?.(); cleanup = null; home(); })); return; }
      const me = c.seats.find((s) => s.id === c.playerId);
      replace(box,
        h("div", { class: "card" }, h("h3", null, session.connected ? `Salon de ${target}` : `Connexion à ${target}…`),
          c.seats.map((s) => seatRow(s)),
          c.hostCommit ? h("div", { class: "muted small mono", style: { marginTop: "6px" }, title: "Engagement SHA-256 du secret de l'hôte, vérifié en fin de partie" }, "engagement de l'hôte : ", c.hostCommit.slice(0, 24), "…") : null),
        c.settings ? h("div", { class: "card" }, h("h3", null, "Réglages (définis par l'hôte)"), settingsEditor({ ...c.settings }, () => {}, false)) : null,
        me ? h("div", { class: "row" },
          select(PLAYER_COLOR_NAMES.map((n, i) => [String(i), n] as [string, string]), String(me.color), (v) => c.setColor(Number(v))),
          button(ready ? "Je ne suis plus prêt" : "Je suis prêt", () => { ready = !ready; c.setReady(ready); }, ready ? "" : "primary"),
          button("Quitter", () => { cleanup?.(); cleanup = null; home(); })) : null);
    };
    session.onChange = draw;
    replace(body, box);
    draw();
  };

  // ------------------------------------------------------------------ home
  const home = () => {
    const portInput = h("input", { type: "number", value: DEFAULT_PORT, min: 1024, max: 65535, style: { width: "100px" } });
    const addr = h("input", { type: "text", placeholder: "192.168.1.20:41234 ou code", class: "grow", onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") joinLobby(addr.value); } });
    replace(body,
      h("div", { class: "card" }, h("label", null, "Votre nom", nameInput)),
      h("div", { class: "grid2" },
        h("div", { class: "card col" }, h("h3", null, "Héberger"),
          h("p", null, "Cette machine devient l'hôte : elle détient l'état de référence et le deck secret, valide chaque action et la diffuse. Aucun serveur externe n'est utilisé."),
          isTauri() ? h("div", { class: "row" }, h("label", null, "Port", portInput), button("Créer un salon", () => void hostLobby(Number(portInput.value) || DEFAULT_PORT), "primary"))
            : h("p", { class: "muted" }, "Ouvrez Bastides sur Android ou Windows pour héberger. Depuis un navigateur, vous pouvez rejoindre une partie.")),
        h("div", { class: "card col" }, h("h3", null, "Rejoindre"),
          h("p", null, "Saisissez l'adresse ou le code affiché chez l'hôte."),
          h("div", { class: "row" }, addr, button("Rejoindre", () => joinLobby(addr.value), "primary")))),
      h("div", { class: "card" }, h("h3", null, "Équité"),
        h("p", { class: "small" }, "Les invités ne reçoivent que les tuiles révélées, jamais l'ordre du deck. Avant la partie l'hôte publie un engagement cryptographique (SHA-256) sur le deck, auquel chaque invité contribue par de l'aléa ; à la fin, le deck est révélé et vérifié automatiquement. Ce mécanisme détecte un deck modifié en cours de partie ; il ne remplace pas un serveur tiers de confiance (l'hôte connaît l'ordre des tuiles).")));
  };
  home();
  const el = h("div", { class: "screen" }, h("div", { class: "screen-inner" },
    h("header", null, button([icon("back", 16), "Menu"], () => app.show(menuScreen)), h("h2", null, "Multijoueur")), body));
  return { el, dispose: () => { disposed = true; cleanup?.(); } };
}
