/**
 * Network play, two ways:
 *  - online: through a Bastides relay server (URL entered once); rooms are joined by a short code.
 *  - local network: this app hosts a WebSocket server; guests join by address or LAN code.
 * Either way the hosting app stays authoritative; several humans may also share the host's screen.
 */
import { decodeRoomCode, encodeRoomCode } from "../../multiplayer/protocol";
import type { LobbySettings, SeatInfo } from "../../multiplayer/protocol";
import { ROOM_CODE, RelayHost, normalizeRoomCode, normalizeServerUrl } from "../../multiplayer/relayClient";
import type { App } from "../app";
import { PLAYER_COLOR_NAMES, button, h, replace, select, toast } from "../dom";
import { icon, shield } from "../heraldry";
import { createBotService, isTauri, prepareNetwork, saveSettings, startNetServer } from "../platform";
import { HostedSession, RemoteSession, relayLink, webSocketLink } from "../sessions";
import type { TableSide } from "../sessions";
import { tableSidePicker } from "../tableSide";
import { gameScreen } from "./game";
import { menuScreen } from "./menu";
import { LEVELS, settingsEditor } from "./setup";

const DEFAULT_PORT = 41234;

function seatRow(s: SeatInfo, extra: (HTMLElement | null)[] = [], where = "sur l'hôte"): HTMLElement {
  const waiting = s.kind !== "bot" && !s.local && !s.connected;
  return h("div", { class: "row seat" + (waiting ? " pending" : ""), style: { padding: "4px 6px" } },
    shield(s.color, 22),
    h("b", { class: "grow" }, s.name), h("span", { class: "muted small" }, s.kind === "bot" ? "bot " + (LEVELS.find((l) => l[0] === s.level)?.[1] ?? "") : s.local ? where : s.connected ? "connecté" : "déconnecté"),
    h("span", { class: s.ready ? "ok" : "muted" }, s.ready ? [icon("check", 15), " prêt"] : "pas encore prêt"), extra);
}

export function multiplayerScreen(app: App) {
  const body = h("div", { class: "col" });
  let cleanup: (() => void) | null = null;
  let busy = false, disposed = false;
  const nameInput = h("input", { type: "text", value: app.settings.name, maxLength: 24, oninput: () => { app.settings.name = nameInput.value; saveSettings(app.settings); } });
  const serverInput = h("input", { type: "url", value: app.settings.serverUrl, placeholder: "https://mon-relais.vercel.app", class: "grow", spellcheck: false, autocomplete: "url" });
  const serverUrl = (): string => {
    const url = normalizeServerUrl(serverInput.value);
    if (!url) { toast("Saisissez l'adresse du serveur (par exemple https://mon-relais.vercel.app).", "error"); serverInput.focus(); return ""; }
    serverInput.value = url;
    app.settings.serverUrl = url;
    saveSettings(app.settings);
    return url;
  };
  const back = () => { cleanup?.(); cleanup = null; home(); };

  // ------------------------------------------------------------------ host lobby (online or LAN)
  const lobby = (session: HostedSession, where: HTMLElement) => {
    session.host.addLocalPlayer(nameInput.value || "Hôte");
    let started = false;
    cleanup = () => { if (!started) session.leave(); };
    const seatsEl = h("div"), startBtn = button("Démarrer la partie", () => {
      const err = session.host.start();
      if (err) return toast(err, "error");
      started = true;
      app.settings.tableSides = session.host.seats.map((s) => session.sides.get(s.id) ?? 0);
      saveSettings(app.settings);
      app.show(gameScreen(session));
    }, "primary");
    const tableNote = h("p", { class: "muted small table-note" }, "Plusieurs joueurs sur l'écran de l'hôte : indiquez de quel côté chacun s'assoit, le plateau pivote vers celui qui joue.");
    const settings: LobbySettings = { ...session.host.settings };
    const draw = () => {
      const seats = session.host.seatInfos();
      const table = seats.filter((s) => s.local && s.kind === "human").length >= 2;
      tableNote.hidden = !table;
      replace(seatsEl, seats.map((s, i) => {
        const here = s.local && s.kind === "human";
        const colour = s.local ? select(PLAYER_COLOR_NAMES.map((n, c) => [String(c), n] as [string, string]), String(s.color), (v) => session.host.updateSeat(s.id, { color: Number(v) })) : null;
        const side = table ? (here ? tableSidePicker(session.sides.get(s.id) ?? 0, (v: TableSide) => session.sides.set(s.id, v), s.name) : h("span", { class: "table-side", "aria-hidden": "true" })) : null;
        const remove = i > 0 ? button("Retirer", () => { session.sides.delete(s.id); session.host.removeSeat(s.id); }, "small") : h("span");
        const row = seatRow(s, [colour ?? h("span"), side ?? h("span"), remove], i === 0 ? "vous" : "sur cet écran");
        row.classList.add("lobby-seat");
        return row;
      }));
      startBtn.disabled = !!session.host.canStart();
      startBtn.title = session.host.canStart();
    };
    session.onChange = draw;
    replace(body,
      where,
      h("div", { class: "card" }, h("h3", null, "Joueurs"), seatsEl, tableNote,
        h("div", { class: "row", style: { marginTop: "8px" } }, LEVELS.map(([lvl, label]) => button([icon("plus", 15), "Bot " + label], () => { if (!session.host.addBot(lvl)) toast("La partie est complète.", "error"); }, "small")),
          button([icon("plus", 15), "Joueur sur cet écran"], () => { if (!session.host.addLocalPlayer(`Joueur ${session.host.seats.length + 1}`)) toast("La partie est complète.", "error"); }, "small"))),
      h("div", { class: "card" }, h("h3", null, "Réglages"), settingsEditor(settings, () => session.host.updateSettings({ ...settings })),
        h("label", null, h("input", { type: "checkbox", checked: settings.replaceAbsent, onchange: (e: Event) => { settings.replaceAbsent = (e.target as HTMLInputElement).checked; session.host.updateSettings({ ...settings }); } }), "Remplacer un joueur déconnecté par un bot pendant son absence")),
      h("div", { class: "row" }, startBtn, button("Fermer le salon", back)));
    draw();
  };

  const hostOnline = async () => {
    if (busy) return;
    const server = serverUrl();
    if (!server) return;
    busy = true;
    const session = new HostedSession(createBotService(() => app.settings.botDelay));
    try {
      session.relay = await RelayHost.open(server, {
        open: (c) => session.host.onConnect(c), message: (c, t) => session.host.onMessage(c, t), close: (c) => session.host.onDisconnect(c),
      });
    } catch (e) {
      if (!disposed) toast(String((e as Error).message ?? e), "error");
      session.leave();
      return;
    } finally { busy = false; }
    if (disposed) { session.leave(); return; }
    session.relay.onFatal = (msg) => toast("Serveur : " + msg, "error");
    const room = session.relay.room;
    const copy = button("Copier", () => {
      void navigator.clipboard?.writeText(room).then(() => toast("Code copié."), () => toast("Copie impossible : notez le code.", "error"));
    }, "small");
    lobby(session, h("div", { class: "card" }, h("h3", null, "Salon en ligne"),
      h("div", { class: "row" }, h("span", null, "Code du salon"), h("b", { class: "room-code", "aria-label": "Code du salon " + room.split("").join(" ") }, room), copy),
      h("p", { class: "muted small", style: { marginTop: "8px" } }, "Les autres joueurs choisissent « En ligne », saisissent le même serveur (", h("span", { class: "mono" }, server), ") puis ce code. Gardez l'application ouverte : c'est elle qui arbitre la partie.")));
  };

  const hostLan = async (port: number) => {
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
    const srv = session.server!;
    const lan = srv.addresses.filter((a) => a !== "127.0.0.1");
    lobby(session, h("div", { class: "card" }, h("h3", null, "Salon en réseau local"),
      lan.length ? lan.map((a) => h("div", { class: "row" }, h("span", null, "Adresse : "), h("b", { class: "mono" }, `${a}:${srv.port}`), h("span", null, " · code : "), h("b", { class: "mono" }, encodeRoomCode(a, srv.port)))) : h("div", { class: "err" }, "Aucune interface réseau locale détectée."),
      h("p", { class: "muted small", style: { marginTop: "8px" } }, "Les joueurs du même réseau se connectent avec l'adresse ou le code. Pour jouer à distance sans configurer la box, utilisez plutôt un salon en ligne.")));
  };

  // ------------------------------------------------------------------ guest
  const guest = (session: RemoteSession) => {
    let started = false, ready = false;
    cleanup = () => { if (!started) session.leave(); };
    const box = h("div", { class: "col" });
    const draw = () => {
      const c = session.client;
      if (c.state && !started) { started = true; app.show(gameScreen(session)); return; }
      if (c.error) { replace(box, h("div", { class: "card err" }, c.error), h("div", { class: "row" }, button("Retour", back))); return; }
      const me = c.seats.find((s) => s.id === c.playerId);
      replace(box,
        h("div", { class: "card" + (session.connected ? "" : " pending") }, h("h3", null, session.connected ? `Salon ${session.label}` : `Connexion à ${session.label}…`),
          c.seats.map((s) => seatRow(s)),
          c.hostCommit ? h("div", { class: "muted small mono", style: { marginTop: "6px" }, title: "Engagement SHA-256 du secret de l'hôte, vérifié en fin de partie" }, "engagement de l'hôte : ", c.hostCommit.slice(0, 24), "…") : null),
        c.settings ? h("div", { class: "card" }, h("h3", null, "Réglages (définis par l'hôte)"), settingsEditor({ ...c.settings }, () => {}, false)) : null,
        h("div", { class: "row" },
          me ? select(PLAYER_COLOR_NAMES.map((n, i) => [String(i), n] as [string, string]), String(me.color), (v) => c.setColor(Number(v))) : null,
          me ? button(ready ? "Je ne suis plus prêt" : "Je suis prêt", () => { ready = !ready; c.setReady(ready); }, ready ? "" : "primary") : null,
          button("Quitter", back)));
    };
    session.onChange = draw;
    replace(body, box);
    draw();
  };

  const joinOnline = (raw: string) => {
    const server = serverUrl();
    if (!server) return;
    const code = normalizeRoomCode(raw);
    if (!ROOM_CODE.test(code)) return toast("Le code du salon compte 6 caractères (lettres et chiffres).", "error");
    guest(new RemoteSession(relayLink(server, code), nameInput.value || "Invité", code));
  };

  const joinLan = async (address: string) => {
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
    guest(new RemoteSession(() => webSocketLink("ws://" + target), nameInput.value || "Invité", target));
  };

  // ------------------------------------------------------------------ home
  const home = () => {
    const roomInput = h("input", { type: "text", placeholder: "Code à 6 caractères", maxLength: 8, class: "grow room-input", autocapitalize: "characters", spellcheck: false, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") joinOnline(roomInput.value); } });
    const portInput = h("input", { type: "number", value: DEFAULT_PORT, min: 1024, max: 65535, style: { width: "100px" } });
    const addr = h("input", { type: "text", placeholder: "192.168.1.20:41234 ou code", class: "grow", onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") void joinLan(addr.value); } });
    replace(body,
      h("div", { class: "card" }, h("label", null, "Votre nom", nameInput)),
      h("div", { class: "card col" }, h("h2", null, "En ligne"),
        h("p", null, "Par un serveur relais, depuis n'importe où : l'hôte crée un salon, les autres le rejoignent avec son code. Le serveur ne fait que transmettre les messages ; l'application de l'hôte arbitre la partie."),
        h("label", { class: "field-wide" }, h("span", null, "Serveur"), serverInput),
        h("div", { class: "grid2" },
          h("div", { class: "col" }, h("h3", null, "Héberger"), h("div", { class: "row" }, button("Créer un salon en ligne", () => void hostOnline(), "primary"))),
          h("div", { class: "col" }, h("h3", null, "Rejoindre"), h("div", { class: "row" }, roomInput, button("Rejoindre", () => joinOnline(roomInput.value), "primary"))))),
      h("div", { class: "card col" }, h("h2", null, "Réseau local"),
        h("p", null, "Sans serveur : cette machine devient l'hôte et les joueurs du même réseau (Wi-Fi, maison, salle) s'y connectent directement."),
        h("div", { class: "grid2" },
          h("div", { class: "col" }, h("h3", null, "Héberger"),
            isTauri() ? h("div", { class: "row" }, h("label", null, "Port", portInput), button("Créer un salon local", () => void hostLan(Number(portInput.value) || DEFAULT_PORT)))
              : h("p", { class: "muted small" }, "L'hébergement en réseau local demande l'application Bastides (Windows ou Android). Depuis un navigateur, créez plutôt un salon en ligne.")),
          h("div", { class: "col" }, h("h3", null, "Rejoindre"),
            h("div", { class: "row" }, addr, button("Rejoindre", () => void joinLan(addr.value)))))),
      h("div", { class: "card" }, h("h3", null, "Équité"),
        h("p", { class: "small" }, "Les invités ne reçoivent que les tuiles révélées, jamais l'ordre du deck. Avant la partie l'hôte publie un engagement cryptographique (SHA-256) sur le deck, auquel chaque invité contribue par de l'aléa ; à la fin, le deck est révélé et vérifié automatiquement. Ce mécanisme détecte un deck modifié en cours de partie ; il ne remplace pas un arbitre tiers de confiance (l'hôte connaît l'ordre des tuiles).")));
  };
  home();
  const el = h("div", { class: "screen" }, h("div", { class: "screen-inner" },
    h("header", null, button([icon("back", 16), "Menu"], () => app.show(menuScreen)), h("h2", null, "Multijoueur")), body));
  return { el, dispose: () => { disposed = true; cleanup?.(); } };
}
