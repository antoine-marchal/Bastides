/// <reference lib="webworker" />
/** Web Worker running bot decisions off the UI thread. Receives a public view only. */
import { chooseTurn } from "./bots";
import type { BotOptions } from "./bots";
import type { GameState } from "../game/state";

self.onmessage = (e: MessageEvent<{ id: number; view: GameState; opts: BotOptions }>) => {
  const { id, view, opts } = e.data;
  try {
    (self as unknown as Worker).postMessage({ id, turn: chooseTurn(view, opts) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
