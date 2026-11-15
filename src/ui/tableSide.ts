/**
 * Table mode seat picker: the table seen in plan, a hairline square with one seat per side.
 * Choosing a side says where that player sits around the screen; during the game the
 * board and the HUD turn to face the active player.
 */
import { h } from "./dom";
import type { TableSide } from "./sessions";

export const SIDE_NAMES = ["en bas", "à gauche", "en haut", "à droite"] as const;
const KEY_SIDE: Record<string, TableSide> = { ArrowDown: 0, ArrowLeft: 1, ArrowUp: 2, ArrowRight: 3 };

export function tableSidePicker(value: TableSide, onChange: (side: TableSide) => void, who = "ce joueur"): HTMLElement {
  const seats = ([0, 1, 2, 3] as TableSide[]).map((side) => h("button", {
    type: "button", class: `ts-seat ts-${side}`, role: "radio",
    title: `Assis ${SIDE_NAMES[side]} de l'écran`, "aria-label": SIDE_NAMES[side],
    onclick: () => pick(side),
  }));
  const el = h("div", {
    class: "table-side", role: "radiogroup", "aria-label": `Place à table de ${who}`,
    onkeydown: (e: KeyboardEvent) => {
      const side = KEY_SIDE[e.key];
      if (side === undefined) return;
      e.preventDefault();
      pick(side);
      seats[side].focus();
    },
  }, h("span", { class: "ts-board", "aria-hidden": "true" }), seats);
  const show = (v: TableSide) => seats.forEach((b, i) => {
    b.setAttribute("aria-checked", String(i === v));
    b.tabIndex = i === v ? 0 : -1; // roving tab stop: arrows move within the group
  });
  const pick = (side: TableSide) => { if (side !== value) { value = side; show(side); onChange(side); } };
  show(value);
  return el;
}
