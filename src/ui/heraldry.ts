/**
 * Heraldic shields and the line-icon set, drawn as inline SVG (no asset file).
 * Each player colour is paired with its own division of the field, so a player is
 * recognisable by pattern as well as by colour.
 */
import { PLAYER_COLORS, PLAYER_COLOR_NAMES } from "./dom";

const NS = "http://www.w3.org/2000/svg";
const ARGENT = "#f1ecdc";
const SHIELD = "M2 2h20v9.5C22 17.5 17.5 21 12 23 6.5 21 2 17.5 2 11.5Z";

/** Division of the field per colour index: the second tincture is always argent. */
const DIVISIONS = [
  "", // Rouge: plain field
  "M12 2h10v22H12Z", // Bleu: per pale
  "M2 12.5h20V24H2Z", // Jaune: per fess
  "M2 2 22 22V24H18L2 6Z", // Vert: per bend (a bend band)
  "M2 17 12 8.5 22 17v4l-10-8.5L2 21Z", // Noir: chevron
  "M12 2h10v10.5H12ZM2 12.5h10V24H2Z", // Rose: quarterly
  "M2 2h3.5L12 8.8 18.5 2H22v3.5L15.2 12.2 22 19v4L12 15.6 2 23v-4l6.8-6.8L2 5.5Z", // Orange: saltire
  "M9 2h6v22H9Z", // Turquoise: pale
];
const BLAZON = ["plein", "parti", "coupé", "à la bande", "au chevron", "écartelé", "au sautoir", "au pal"];

function svg(viewBox: string, cls: string): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", viewBox);
  s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  return s;
}
function path(d: string, attrs: Record<string, string>): SVGPathElement {
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  return p;
}

let clipSeq = 0;
/** A small escutcheon for player colour `index`; `size` in CSS px. */
export function shield(index: number, size = 18): SVGSVGElement {
  const i = ((index % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length;
  const s = svg("0 0 24 25", "shield");
  s.style.width = s.style.height = size + "px";
  s.setAttribute("aria-hidden", "false");
  s.setAttribute("role", "img");
  s.setAttribute("aria-label", `${PLAYER_COLOR_NAMES[i]}, ${BLAZON[i]}`);
  const id = "shc" + ++clipSeq;
  const clip = document.createElementNS(NS, "clipPath");
  clip.setAttribute("id", id);
  clip.appendChild(path(SHIELD, {}));
  s.appendChild(clip);
  s.appendChild(path(SHIELD, { fill: PLAYER_COLORS[i] }));
  if (DIVISIONS[i]) s.appendChild(path(DIVISIONS[i], { fill: ARGENT, "clip-path": `url(#${id})` }));
  s.appendChild(path(SHIELD, { fill: "none", stroke: "#0d1b30", "stroke-width": "1.6", "stroke-linejoin": "round" }));
  return s;
}

// ---------------------------------------------------------------- icons (24px grid, 1.75 stroke)
const ICONS: Record<string, string> = {
  back: "M15 5 8 12l7 7",
  rotate: "M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4",
  close: "M6 6l12 12M18 6 6 18",
  minimize: "M6 12h12",
  maximize: "M6 6h12v12H6Z",
  restore: "M8.5 8.5h9.5v9.5H8.5ZM6 15.5V6h9.5",
  play: "M8 5.5v13l10.5-6.5Z",
  pause: "M8 5.5v13M16 5.5v13",
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
  first: "M7 6v12M17 6l-6 6 6 6",
  last: "M17 6v12M7 6l6 6-6 6",
  centre: "M12 3v4M12 17v4M3 12h4M17 12h4M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  inspect: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM15.5 15.5 20 20",
  menu: "M4 7h16M4 12h16M4 17h16",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7.5",
};
export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 18): SVGSVGElement {
  const s = svg("0 0 24 24", "icon");
  s.style.width = s.style.height = size + "px";
  s.appendChild(path(ICONS[name], { fill: name === "play" ? "currentColor" : "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  return s;
}
