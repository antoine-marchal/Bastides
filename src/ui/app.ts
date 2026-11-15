import { TileCache } from "../procedural/rendering/tileCache";
import { clear } from "./dom";
import { loadSettings } from "./platform";
import type { Settings } from "./platform";

export interface ScreenInstance { el: HTMLElement; dispose?: () => void }
export type Screen = (app: App) => ScreenInstance;

export class App {
  readonly cache = new TileCache();
  settings: Settings = loadSettings();
  private current: ScreenInstance | null = null;
  constructor(readonly root: HTMLElement) {}
  show(screen: Screen): void {
    this.current?.dispose?.();
    clear(this.root);
    this.current = screen(this);
    this.root.appendChild(this.current.el);
  }
}
