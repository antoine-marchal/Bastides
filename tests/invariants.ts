import { DX, DY, cellKey, keyX, keyY } from "../src/core/coordinates";
import { find, tileTopology, topoIndex } from "../src/game/gameEngine";
import { MEEPLES_PER_PLAYER, TurnPhase } from "../src/game/state";
import type { GameState } from "../src/game/state";

/** Recompute derived data from scratch and compare with the incrementally maintained state. */
export function checkInvariants(s: GameState): string[] {
  const errors: string[] = [];
  const onBoard = s.players.map(() => 0);
  const open = new Map<number, number>();
  s.tiles.forEach((tile, ti) => {
    const topo = tileTopology(tile), ix = topoIndex(topo);
    if (s.board.get(cellKey(tile.x, tile.y)) !== ti) errors.push("board index mismatch");
    for (let side = 0; side < 4; side++) {
      const nb = s.board.get(cellKey(tile.x + DX[side], tile.y + DY[side]));
      if (nb !== undefined) {
        if (tileTopology(s.tiles[nb]).edges[(side + 2) & 3] !== topo.edges[side]) errors.push(`edge mismatch at tile ${ti} side ${side}`);
      } else if (ix.side[side] >= 0) {
        const r = find(s, tile.base + ix.side[side]);
        open.set(r, (open.get(r) ?? 0) + 1);
      }
    }
  });
  for (const [root, region] of s.regions) {
    if (find(s, root) !== root) errors.push("region keyed by non-root");
    if ((region.kind === "road" || region.kind === "city") && region.open !== (open.get(root) ?? 0)) errors.push(`open count of ${region.kind}:${root} is ${region.open}, expected ${open.get(root) ?? 0}`);
    if (region.done && region.meeples.length && s.phase !== TurnPhase.GAME_OVER) errors.push("settled region still holds meeples");
    if ((region.kind === "road" || region.kind === "city") && region.open === 0 && !region.done && s.lastTile < 0) errors.push("completed region not settled");
    for (const m of region.meeples) {
      onBoard[m.player]++;
      if (find(s, s.tiles[m.tile].base + m.feature) !== root) errors.push("meeple outside its region");
    }
  }
  s.players.forEach((p, i) => {
    if (p.meeples + onBoard[i] !== MEEPLES_PER_PLAYER) errors.push(`player ${i}: ${p.meeples} in hand + ${onBoard[i]} on board`);
    if (p.meeples < 0) errors.push("negative meeples");
    const logged = s.log.filter((e) => e.winningPlayerIds.includes(s.config.players[i].id)).reduce((n, e) => n + e.points, 0);
    if (logged !== p.score) errors.push(`player ${i}: score ${p.score} but events sum to ${logged}`);
    if (p.score !== p.duringGame + p.final) errors.push("score breakdown mismatch");
    if (p.score !== p.byKind.city + p.byKind.road + p.byKind.field + p.byKind.monastery) errors.push("score by kind mismatch");
  });
  const frontier = new Set<number>();
  for (const t of s.tiles) for (let side = 0; side < 4; side++) {
    const k = cellKey(t.x + DX[side], t.y + DY[side]);
    if (!s.board.has(k)) frontier.add(k);
  }
  if (frontier.size !== s.frontier.size || [...frontier].some((k) => !s.frontier.has(k))) errors.push("frontier mismatch");
  for (const k of s.frontier) if (cellKey(keyX(k), keyY(k)) !== k) errors.push("key codec");
  const ids = s.log.filter((e) => !e.final).map((e) => e.featureId);
  if (new Set(ids).size !== ids.length) errors.push("a feature was scored twice");
  if (s.deck.total >= 0 && s.tiles.length + s.discarded.length + (s.current ? 1 : 0) !== s.deck.pos) errors.push("tile accounting mismatch");
  return errors;
}
