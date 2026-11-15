/** Replay navigation with periodic checkpoints (seeking backwards never replays from zero). */
import { applyAction } from "../game/gameEngine";
import type { GameState } from "../game/state";
import { initialState } from "./serialization";
import type { Recording } from "./serialization";

export class ReplayPlayer {
  private checkpoints: GameState[] = [];
  private state: GameState;
  private index = 0;
  static readonly STEP = 16;

  constructor(readonly rec: Recording) {
    this.state = initialState(rec);
    this.checkpoints[0] = this.state;
  }
  get length(): number { return this.rec.actions.length; }
  get position(): number { return this.index; }
  get current(): GameState { return this.state; }

  seek(target: number): GameState {
    target = Math.max(0, Math.min(this.length, Math.floor(target)));
    if (target < this.index) {
      const cp = Math.floor(target / ReplayPlayer.STEP);
      this.state = this.checkpoints[cp];
      this.index = cp * ReplayPlayer.STEP;
    }
    while (this.index < target) {
      const [player, action] = this.rec.actions[this.index];
      const r = applyAction(this.state, action, player);
      if (!r.ok) throw new Error(`Replay invalide à l'action ${this.index + 1} : ${r.error}`);
      this.state = r.state;
      this.index++;
      if (this.index % ReplayPlayer.STEP === 0) this.checkpoints[this.index / ReplayPlayer.STEP] = this.state;
    }
    return this.state;
  }
  step(delta = 1): GameState { return this.seek(this.index + delta); }
}
