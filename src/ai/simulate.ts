/** Headless bot-versus-bot games (tests, balance statistics, benchmarks). */
import { applyAction, createGame } from "../game/gameEngine";
import type { CreateOptions } from "../game/gameEngine";
import { TurnPhase } from "../game/state";
import type { GameAction, GameConfig, GameState } from "../game/state";
import { botSeedKey, chooseTurn, turnActions } from "./bots";
import { publicView } from "./view";

export interface SimResult { state: GameState; actions: GameAction[] }

export function playBotGame(config: GameConfig, opts: { create?: CreateOptions; simulations?: number; maxTurns?: number } = {}): SimResult {
  let state = createGame(config, opts.create);
  const actions: GameAction[] = [];
  let guard = 0;
  const maxTurns = opts.maxTurns ?? 100000;
  while (state.phase !== TurnPhase.GAME_OVER) {
    if (state.phase !== TurnPhase.PLACE_TILE) throw new Error("bot game stuck in phase " + state.phase);
    if (state.turn >= maxTurns) {
      if (config.mode !== "sandbox") break; // partial game requested
      const r = applyAction(state, { type: "END_GAME" });
      if (!r.ok) throw new Error(r.error);
      actions.push({ type: "END_GAME" });
      state = r.state;
      break;
    }
    const player = state.player, turn = state.turn;
    const level = config.players[player].level ?? "normal";
    const decision = chooseTurn(publicView(state), { level, seedKey: botSeedKey(state), simulations: opts.simulations });
    for (const a of turnActions(decision)) {
      if (state.phase === TurnPhase.GAME_OVER || state.player !== player || state.turn !== turn) break;
      const r = applyAction(state, a);
      if (!r.ok) throw new Error(`illegal bot action ${JSON.stringify(a)}: ${r.error}`);
      actions.push(a);
      state = r.state;
    }
    if (++guard > 1e6) throw new Error("runaway bot game");
  }
  return { state, actions };
}
