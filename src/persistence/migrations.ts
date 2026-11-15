/** Save-format migrations: each entry upgrades format n to n + 1. */
import { SAVE_FORMAT_VERSION } from "../core/types";
import type { SaveFile } from "./serialization";
import { SaveError } from "./serialization";

type Migration = (old: Record<string, unknown>) => Record<string, unknown>;

/** Format 0 (pre-release): `history` instead of `actions`, no `total`. */
const MIGRATIONS: Record<number, Migration> = {
  0: (old) => {
    const deck = (old.deck as unknown[]) ?? [];
    return { ...old, format: 1, actions: old.history ?? [], total: old.total ?? deck.length, app: "bastides", history: undefined };
  },
};

export function migrate(raw: unknown): SaveFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SaveError("Format de sauvegarde inconnu.");
  let data = raw as Record<string, unknown>;
  if (typeof data.format !== "number" || !Number.isInteger(data.format) || data.format < 0) throw new SaveError("Format de sauvegarde inconnu.");
  if (data.format > SAVE_FORMAT_VERSION) throw new SaveError(`Sauvegarde au format v${data.format}, plus récent que cette version du jeu (v${SAVE_FORMAT_VERSION}). Mettez le jeu à jour.`);
  while ((data.format as number) < SAVE_FORMAT_VERSION) {
    const m = MIGRATIONS[data.format as number];
    if (!m) throw new SaveError(`Aucune migration disponible depuis le format v${data.format}.`);
    data = m(data);
  }
  if (data.app !== "bastides") throw new SaveError("Ce fichier n'est pas une sauvegarde de ce jeu.");
  return data as unknown as SaveFile;
}
