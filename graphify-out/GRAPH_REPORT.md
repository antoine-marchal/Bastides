# Graph Report - carca  (2026-11-15)

## Corpus Check
- 69 files · ~57,045 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: (none) 1, .css 1)

## Summary
- 758 nodes · 2471 edges · 24 communities (20 shown, 4 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 78 edges (avg confidence: 0.83)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Game Engine & Bots
- UI Platform & Sessions
- Multiplayer Authority
- Tauri Network Relay
- Tile Topology Generator
- PRNG, Hashing & Deck
- Geometry Masks & Validator
- Native Storage & Docs
- Tile Geometry Shapes
- Persistence & Replay
- npm Package Config
- Board Renderer & Cache
- Tauri Config
- Tile Painting & Noise
- Build Scripts
- Coordinates & Decor
- TypeScript Config
- Core Types
- Render Level of Detail
- Tauri Capabilities
- HTML Entry
- Cargo Manifest

## God Nodes (most connected - your core abstractions)
1. `gameScreen()` - 51 edges
2. `GameHost` - 38 edges
3. `GameState` - 34 edges
4. `labScreen()` - 31 edges
5. `BoardView` - 29 edges
6. `h()` - 29 edges
7. `menuScreen()` - 25 edges
8. `TileDef` - 24 edges
9. `createGame()` - 24 edges
10. `TurnPhase` - 23 edges

## Surprising Connections (you probably didn't know these)
- `playOut()` --calls--> `legalPlacements()`  [EXTRACTED]
  tests/multiplayer.test.ts → src/game/gameEngine.ts
- `oriented()` --calls--> `canonicalSpec()`  [EXTRACTED]
  tests/helpers.ts → src/procedural/topology/catalog.ts
- `oriented()` --calls--> `rotateSpec()`  [EXTRACTED]
  tests/helpers.ts → src/procedural/topology/generator.ts
- `oriented()` --calls--> `specId()`  [EXTRACTED]
  tests/helpers.ts → src/procedural/topology/generator.ts
- `oriented()` --calls--> `parseSpecId()`  [EXTRACTED]
  tests/helpers.ts → src/procedural/topology/generator.ts

## Import Cycles
- 3-file cycle: `src/ui/screens/game.ts -> src/ui/screens/menu.ts -> src/ui/screens/multiplayer.ts -> src/ui/screens/game.ts`
- 3-file cycle: `src/ui/screens/game.ts -> src/ui/screens/menu.ts -> src/ui/screens/setup.ts -> src/ui/screens/game.ts`
- 3-file cycle: `src/ui/screens/game.ts -> src/ui/screens/menu.ts -> src/ui/screens/saves.ts -> src/ui/screens/game.ts`
- 3-file cycle: `src/ui/screens/game.ts -> src/ui/screens/replay.ts -> src/ui/screens/saves.ts -> src/ui/screens/game.ts`
- 4-file cycle: `src/ui/screens/game.ts -> src/ui/screens/menu.ts -> src/ui/screens/multiplayer.ts -> src/ui/screens/setup.ts -> src/ui/screens/game.ts`

## Communities (24 total, 4 thin omitted)

### Community 0 - "Game Engine & Bots"
Cohesion: 0.05
Nodes (106): vitest, BotOptions, botSeedKey(), BotTurn, Candidate, chooseTurn(), DEFAULT_SIMULATIONS, enumerateTurns() (+98 more)

### Community 1 - "UI Platform & Sessions"
Cohesion: 0.07
Nodes (69): randomSeedString(), ranking(), tilesRemaining(), app, BotRunner, HostTransport, Audit, loadSave() (+61 more)

### Community 2 - "Multiplayer Authority"
Cohesion: 0.06
Nodes (33): SimResult, canonicalJson(), sha256(), PROTOCOL_VERSION, publicSummary(), stateHash(), BotLevel, GameAction (+25 more)

### Community 3 - "Tauri Network Relay"
Cohesion: 0.06
Nodes (24): Net, net_close(), net_send(), net_start(), net_stop(), NetInfo, save_delete(), save_list() (+16 more)

### Community 4 - "Tile Topology Generator"
Cohesion: 0.13
Nodes (40): 103 canonical topologies, rotatePort(), Side, TileEdges, TileTopology, ALL_EDGE_CONFIGS, build(), canonicalId() (+32 more)

### Community 5 - "PRNG, Hashing & Deck"
Cohesion: 0.11
Nodes (24): sandboxTileFromRng(), deriveSeed(), fmix32(), K, murmur3(), utf8(), createRandom(), RANDOM_VERSION (+16 more)

### Community 6 - "Geometry Masks & Validator"
Cohesion: 0.12
Nodes (29): Independent geometry validator, Terrain, CITY, GRASS, ROAD, components(), despeckle(), K_CITY (+21 more)

### Community 7 - "Native Storage & Docs"
Cohesion: 0.10
Nodes (21): SHA-256 deck commitment, Meadows derived from obstacle faces, Known limitations, Named PRNG streams (fork by key), Bot public view (unseen multiset), GameState + GameAction -> GameState, Save = params + deck + action log, Tauri shell: atomic storage + WS relay (+13 more)

### Community 8 - "Tile Geometry Shapes"
Cohesion: 0.15
Nodes (25): CORNERS, sidePoint(), Pt, CityShape, Component, distToPolyline(), distToSegment(), GateShape (+17 more)

### Community 9 - "Persistence & Replay"
Cohesion: 0.14
Nodes (14): SAVE_FORMAT_VERSION, validateConfig(), GameConfig, GameState, migrate(), Migration, MIGRATIONS, ReplayPlayer (+6 more)

### Community 10 - "npm Package Config"
Cohesion: 0.09
Nodes (24): dependencies, @tauri-apps/api@^2, devDependencies, @tauri-apps/cli@^2, typescript@^5.6.0, vite@^6.0.0, vitest@^3.0.0, name (+16 more)

### Community 11 - "Board Renderer & Cache"
Cohesion: 0.14
Nodes (3): TileCache, BoardView, backdrop()

### Community 12 - "Tauri Config"
Cohesion: 0.09
Nodes (21): app, security, windows, withGlobalTauri, build, beforeBuildCommand, beforeDevCommand, devUrl (+13 more)

### Community 13 - "Tile Painting & Noise"
Cohesion: 0.19
Nodes (19): hash2(), House, Tree, fbm(), valueNoise(), Ctx, drawHouse(), drawMonastery() (+11 more)

### Community 14 - "Build Scripts"
Cohesion: 0.13
Nodes (9): dib(), header, images, pixel(), sizes, images, rel, root (+1 more)

### Community 15 - "Coordinates & Decor"
Cohesion: 0.18
Nodes (11): INWARD, matchingPort(), NEIGHBOURS8, rotatePoint(), unrotatePoint(), TILE_SIZE, distanceField(), featureIndex() (+3 more)

### Community 16 - "TypeScript Config"
Cohesion: 0.13
Nodes (14): compilerOptions, isolatedModules, lib, module, moduleResolution, noEmit, noFallthroughCasesInSwitch, noImplicitOverride (+6 more)

### Community 17 - "Core Types"
Cohesion: 0.14
Nodes (13): CityRegion, FieldPort, FieldRegion, GENERATOR_VERSION, PORT_NAMES, ROAD_WIDTH, RoadRegion, RoadTerminal (+5 more)

### Community 18 - "Render Level of Detail"
Cohesion: 0.31
Nodes (9): featureAt(), generateGeometry(), geometrySeedOf(), rotatedAnchor(), makeCanvas(), TileBitmap, getTopology(), Highlight (+1 more)

### Community 19 - "Tauri Capabilities"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

## Knowledge Gaps
- **14 isolated node(s):** `bastides`, `GRASS`, `ROAD`, `CITY`, `DRAW_TILE` (+9 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 183 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `README Bastides` connect `Native Storage & Docs` to `Tile Topology Generator`, `Geometry Masks & Validator`?**
  _High betweenness centrality (0.171) - this node is a cross-community bridge._
- **Are the 8 inferred relationships involving `gameScreen()` (e.g. with `.show()` and `.centerOn()`) actually correct?**
  _`gameScreen()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `bastides`, `GRASS`, `ROAD` to the rest of the system?**
  _14 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Game Engine & Bots` be split into smaller, more focused modules?**
  _Cohesion score 0.05494361395226856 - nodes in this community are weakly interconnected._
- **Why does `Independent geometry validator` connect `Geometry Masks & Validator` to `Tile Geometry Shapes`, `Native Storage & Docs`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `labScreen()` (e.g. with `.show()` and `menuScreen()`) actually correct?**
  _`labScreen()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Should `UI Platform & Sessions` be split into smaller, more focused modules?**
  _Cohesion score 0.06577323223417386 - nodes in this community are weakly interconnected._