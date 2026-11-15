/**
 * HTML title bar for the undecorated desktop window: the bastide's wall-walk.
 * Wordmark on the left, the active player's banner in the middle during a game,
 * window controls (tower stubs) on the right. Not shown in a browser tab or on Android,
 * where the system already provides the frame. `?titlebar` forces it for development.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { h, replace } from "./dom";
import { icon } from "./heraldry";
import { isTauri } from "./platform";

const isAndroid = () => /Android/i.test(navigator.userAgent);
export const hasTitlebar = (): boolean =>
  (isTauri() && !isAndroid()) || new URLSearchParams(location.search).has("titlebar");

let bannerEl: HTMLElement | null = null;
let bannerKey = "";

/** Show (or clear with null) the current-turn banner in the title bar. */
export function setTitleBanner(content: Node | null): void {
  if (!bannerEl) return;
  if (!content) { bannerEl.classList.remove("up", "march"); bannerKey = ""; return; }
  // First hoist drops the banner from the wall; each later change of player carries it along the wall-walk.
  const key = (content as Element).querySelector?.("b")?.textContent ?? "";
  replace(bannerEl, content);
  if (key !== bannerKey) {
    const first = bannerKey === "";
    bannerKey = key;
    if (!first) { bannerEl.classList.remove("march"); void bannerEl.offsetWidth; bannerEl.classList.add("march"); }
  }
  bannerEl.classList.add("up");
}

/**
 * Without a title bar (browser tab, Android), the banner hangs from the top of `host`
 * instead, so the turn banner exists on every platform. Returns a detach function.
 */
export function attachBanner(host: HTMLElement, inGame = false): () => void {
  if (hasTitlebar() && !inGame) return () => setTitleBanner(null);
  const previous = bannerEl;
  const el = h("div", { class: "tb-banner", "aria-live": "polite" });
  host.appendChild(el);
  bannerEl = el; bannerKey = "";
  return () => { if (bannerEl === el) { bannerEl = previous; bannerKey = ""; } el.remove(); };
}

export function mountTitlebar(): void {
  if (!hasTitlebar()) return;
  const win = isTauri() ? getCurrentWindow() : null;
  const ctl = (label: string, name: "minimize" | "maximize" | "close", run: () => void) => {
    const b = h("button", { class: "tb-btn tb-" + name, type: "button", "aria-label": label, title: label, onclick: run }, icon(name, 16));
    return b;
  };
  const maxBtn = ctl("Agrandir", "maximize", () => { void win?.toggleMaximize(); });
  const syncMax = async () => {
    const max = win ? await win.isMaximized().catch(() => false) : false;
    replace(maxBtn, icon(max ? "restore" : "maximize", 16));
    const label = max ? "Restaurer" : "Agrandir";
    maxBtn.setAttribute("aria-label", label); maxBtn.title = label;
    document.documentElement.classList.toggle("win-max", max);
  };
  bannerEl = h("div", { class: "tb-banner", "data-tauri-drag-region": "", "aria-live": "polite" });
  const bar = h("header", { class: "titlebar", "data-tauri-drag-region": "" },
    h("div", { class: "tb-mark", "data-tauri-drag-region": "" }, "Bastides"),
    bannerEl,
    h("div", { class: "tb-controls" },
      ctl("Réduire", "minimize", () => { void win?.minimize(); }),
      maxBtn,
      ctl("Fermer", "close", () => { void win?.close(); })));
  document.body.classList.add("has-titlebar");
  document.body.prepend(bar);
  if (win) { void syncMax(); void win.onResized(() => { void syncMax(); }); }
}
