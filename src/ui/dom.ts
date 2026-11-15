/** Tiny DOM helpers (no framework). */
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in el && k !== "list") (el as unknown as Props)[k] = v;
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}
function append(el: Node, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) { for (const x of c) append(el, x); return; }
  el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
}
export function clear(el: Element): void { while (el.firstChild) el.removeChild(el.firstChild); }
export function replace(el: Element, ...children: Child[]): void { clear(el); append(el, children); }

export function button(label: Child, onClick: () => void, cls = ""): HTMLButtonElement {
  return h("button", { class: "btn " + cls, type: "button", onclick: onClick }, label);
}

export function select<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = h("select", { onchange: () => onChange(s.value as T) }, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
  return s;
}

export function slider(min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
  const s = h("input", { type: "range", min, max, step, value, oninput: () => onInput(Number(s.value)) });
  return s;
}

let toastTimer = 0;
export function toast(message: string, kind: "info" | "error" = "info"): void {
  let el = document.getElementById("toast");
  if (!el) { el = h("div", { id: "toast", role: "status" }); document.body.appendChild(el); }
  el.textContent = message;
  el.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el!.className = ""; }, 3200);
}

export function modal(title: string, body: Child, actions: Child, onClose?: () => void, host = document.body): { close: () => void; el: HTMLElement } {
  const close = () => { wrap.remove(); onClose?.(); };
  const wrap = h("div", { class: "modal-wrap", onclick: (e: Event) => { if (e.target === wrap && onClose) close(); } },
    h("div", { class: "modal", role: "dialog", "aria-label": title }, h("h2", null, title), h("div", { class: "modal-body" }, body), h("div", { class: "modal-actions" }, actions)));
  host.appendChild(wrap);
  return { close, el: wrap };
}

export const PLAYER_COLORS = ["#c0392b", "#2f6fb5", "#e0b12a", "#3d8f4f", "#39343d", "#b0569b", "#e07b2a", "#3aa7a0"];
export const PLAYER_COLOR_NAMES = ["Rouge", "Bleu", "Jaune", "Vert", "Noir", "Rose", "Orange", "Turquoise"];
