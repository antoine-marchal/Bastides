# Bastides

Jeu de pose de tuiles médiéval, **entièrement procédural**, inspiré des mécanismes du jeu de base de Carcassonne : solo contre bots, plusieurs humains sur une machine, réseau local ou distant (hôte autoritaire), avec ou sans bots.

Aucune image, police, texture ou son n'est embarqué : les tuiles, leur topologie, leur géométrie, leur dessin, les pions, l'icône de l'application et les sons sont calculés. L'identité graphique est originale ; aucune illustration ni marque du jeu commercial n'est reprise.

- Moteur : TypeScript strict, sans dépendance, indépendant du DOM, de Canvas, de Tauri et du réseau.
- Rendu : Canvas 2D. Interface : HTML/CSS sans framework.
- Bureau : Tauri 2 ; Rust uniquement pour le stockage des sauvegardes et le relais WebSocket.
- Tests : Vitest (80 tests) et `cargo test` (5 tests).

## Installation et développement

Prérequis : Node.js ≥ 20, Rust stable (pour l'application de bureau), WebView2 sous Windows (présent par défaut sur Windows 10/11).

```bash
npm install
npm test            # suite complète, ~40 s (dont 3 000 parties bot contre bot)
npm run dev         # frontend seul : http://localhost:1420 (tout sauf l'hébergement réseau)
npm run tauri dev   # application de bureau en développement
```

Autres commandes : `npm run typecheck`, `npm run build` (frontend), `npm run measure` (tailles), `cd src-tauri && cargo test`.

## Compilation

```bash
npm run tauri build
```

Produit `src-tauri/target/release/bastides.exe` et l'installateur NSIS dans `src-tauri/target/release/bundle/nsis/`. L'icône `.ico` est générée par `scripts/make-icon.mjs` (formule mathématique, encodage BMP) avant chaque build ; elle n'est pas versionnée.

Seule la cible **Windows x64** a été compilée et mesurée ici. Pour les autres plateformes (non testées dans cet environnement) :

| Plateforme | Prérequis | Commande |
|---|---|---|
| macOS | Xcode Command Line Tools ; icônes `icns`/`png` (`npx tauri icon <image>` à partir d'une image générée) | `npm run tauri build -- --bundles dmg` |
| Linux | `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `build-essential`, `libssl-dev` ; icônes `png` | `npm run tauri build -- --bundles deb,appimage` |

Dans `tauri.conf.json`, `bundle.targets` vaut `["nsis"]` et `bundle.icon` ne liste que l'`ico` : il faut y ajouter les cibles et icônes de la plateforme visée. Le code Rust n'a rien de spécifique à Windows.

## Architecture

```
src/core/          types, PRNG, hachages (murmur3, SHA-256), coordonnées
src/procedural/
  topology/        partitions non croisées, générateur combinatoire, catalogue, validateur
  geometry/        génération planaire, masques raster, validateur indépendant
  rendering/       bruit, décor, dessin Canvas, cache LRU
src/game/          état, deck, automate de jeu (plateau, Union-Find, tours, scores)
src/ai/            vue publique, évaluation, 4 bots, worker, simulation headless
src/multiplayer/   protocole, hôte autoritaire, session cliente
src/persistence/   sauvegarde, migrations, replay
src/ui/            écrans, vue plateau, sessions, services de plateforme
src-tauri/         commandes natives : stockage atomique, relais WebSocket
tests/             topologie, géométrie, règles, bots, déterminisme, multijoueur, simulation
```

Principe central : `GameState + GameAction → GameState`. Humains, bots, clients réseau et replays passent tous par `applyAction` et ses validateurs ; l'interface ne modifie jamais un état. Les parties locales utilisent la même classe `GameHost` que l'hôte réseau.

## Modèle topologique

Une tuile a quatre côtés (N, E, S, W) de type prairie, chemin ou cité : 81 configurations, 24 classes à rotation près. Les côtés ne suffisent pas : la **topologie** dit ce qui est relié à l'intérieur.

- 4 interfaces principales (chemin ou cité au centre d'un côté) et 8 ports de prairie `N0 N1 E0 E1 S0 S1 W0 W1`, dans le sens horaire. Au raccordement, `E0 ↔ W1`, `E ↔ W`, `E1 ↔ W0`.
- Une topologie = régions de cité (côtés, blasons), régions de chemin (côtés, terminaison), régions de prairie (ports, cités adjacentes), terminaisons (carrefour, village, porte de cité, abbaye), abbaye.
- Identifiant stable et lisible, par exemple `CRFR-c0-r13` (cité au nord, chemin est-ouest) ou `CCRC-c013s-e2g0` (cité sur trois côtés avec blason, chemin sud entrant par une porte).

**Génération combinatoire** (`topology/generator.ts`) : pour chaque configuration, énumération des partitions des côtés cité et des structures de chemins (traversants, impasses, carrefour commun, deux virages indépendants pour quatre chemins), des terminaisons, abbayes et blasons. Les partitions de tous les terrains sont évaluées **conjointement** : cités, chemins traversants et carrefours forment des groupes d'obstacles qui ne doivent pas se croiser (une cité N–S et un chemin E–O sont rejetés). S'ajoutent des règles de surface disponible (une impasse coincée dans la lentille d'une cité doit être une porte ; une porte doit border la face où arrive le chemin).

Les **prairies sont dérivées**, jamais déclarées : ce sont les faces laissées entre les groupes d'obstacles sur le pourtour. Deux cités indépendantes sur des côtés adjacents gardent un coin de prairie entre elles ; quatre cités indépendantes enferment une prairie sans port.

Le catalogue contient **103 topologies canoniques** (une par classe de rotation), calculées au démarrage en quelques millisecondes. Les matrices de continuité (cités, chemins « score », chemins « physique », prairies 8×8) sont dérivées des partitions.

## Génération procédurale

**Géométrie** (`geometry/tileGeometry.ts`), en unités de 128 × 128 :

1. Enveloppes de cité : le contour suit les côtés de la cité, et chaque rempart est une courbe joignant des coins de tuile, dont la profondeur dépend du contexte (cité voisine, chemin, abbaye) et de la seed.
2. Abbaye, carrefours et villages : placés par recherche du meilleur point selon un critère de dégagement.
3. Chemins : splines de Hermite passant par des points de passage validés ; les 10 premiers pixels sont droits et perpendiculaires au bord, centrés sur 64, largeur 16.
4. Rastérisation en **masques logiques** (type de terrain + identifiant de région par pixel).
5. Prairies : composantes connexes (4 voisins) de ce qui reste.

**Contrat des bords** : un côté cité est urbain sur toute sa longueur utile et ne porte aucun rempart ; un rempart se termine exactement sur un coin. Une zone de transition de 7 px à chaque coin est exclue des contrôles d'interface. Deux cités indépendantes adjacentes reculent chacune de 6 px du coin commun : un contact ponctuel ne fusionne jamais deux régions.

**Validateur indépendant** (`geometry/validator.ts`) : il ne connaît pas le générateur. À partir du seul masque, il reconstruit interfaces, régions connexes, connectivité physique et de score des chemins, portes, dégagements minimaux, prairies et adjacences prairie–cité, puis compare à la topologie attendue. Une géométrie non conforme est rejetée : nouvelle tentative avec une autre sous-seed (6 au plus), puis repli déterministe « calme », puis erreur explicite. Sur 4 120 géométries testées, 4 ont demandé une seconde tentative et aucune le repli.

**Rendu** (`rendering/`) : sols par pixel avec bruit de valeur et fBm en coordonnées du monde (prairies et pavés continus d'une tuile à l'autre), chemins en traits superposés, remparts, tours, portes, maisons à toits de terre cuite, forêts guidées par un bruit basse fréquence, champs cultivés, blasons héraldiques générés, abbayes, pions. Les décors lisent les masques et ne les modifient jamais. Trois niveaux de détail (64, 128, 256 px), cache LRU borné en mémoire.

## Aléatoire

- Générateur : **xoshiro128\*\*** en arithmétique entière 32 bits, état initialisé par quatre passes MurmurHash3 et un brassage SplitMix32.
- Les flux sont nommés par chemin de clés (`…/deck/order`, `…/bot:2/turn:14`). `fork(label)` ne dépend que de la clé, pas du nombre de tirages déjà effectués : changer le nombre d'arbres ne décale ni le deck ni les bots.
- Entiers sans biais modulo (rejet), mélange de Fisher-Yates, seeds initiales par `crypto.getRandomValues`.
- Chaque tuile porte une seed de 32 bits ; les seeds de géométrie et de dessin en sont dérivées par domaine. Une tuile se régénère seule, sans dépendre des autres.
- Le moteur n'utilise jamais `Math.random()`.

Un PRNG n'est pas un aléa véritable : il est reproductible par construction, et son imprévisibilité vient uniquement de la seed initiale. Les tests statistiques (chi-deux sur entiers, flottants, permutations, positions de tirage ; fréquences des terrains, blasons, abbayes, rotations et défausses) détectent les biais grossiers, pas les défauts fins ; leurs seuils (p ≈ 0,001) peuvent, rarement, échouer sur un générateur correct si l'on change les seeds de test.

## Decks

- **Classique** : composition logique des 72 tuiles du jeu de base (24 types, 10 blasons, 6 abbayes), tuile de départ comprise, mélangée avant la partie.
- **Procédural** : tirage pondéré sur tout le catalogue, sous quotas (arrondi au plus fort reste) pour éviter les decks déséquilibrés. Réglages : densités de cités, chemins, prairies, fréquences d'abbayes, de blasons, de carrefours, de cités traversantes, complexité, diversité.
- **Bac à sable** : génération sans fin, la tuile *i* étant une fonction pure de la seed et de *i* ; la partie se termine sur demande.

Le deck est fixé avant le premier tour et n'est jamais adapté au joueur actif ni aux scores.

## Règles implémentées

2 à 5 joueurs, 7 partisans chacun. Tour : tirer, orienter, poser, poser éventuellement un partisan, compter les régions terminées, rendre les partisans, joueur suivant.

- Pose : la tuile touche au moins une tuile par un côté et tous les côtés en contact concordent. Une tuile impossible à poser est défaussée et remplacée.
- Partisan : un seul, sur une région de la tuile posée, si la région globale est libre (vérifié après les fusions). Des régions occupées peuvent fusionner ensuite.
- Chemin : 1 point par tuile, terminé ou non.
- Cité : 2 points par tuile et par blason si terminée, 1 en fin de partie.
- Abbaye : 9 points entourée, sinon 1 + nombre de voisines en fin de partie.
- Prairie : 3 points par cité terminée adjacente, en fin de partie ; les paysans peuvent être désactivés.
- Majorité : tous les joueurs à égalité au maximum marquent la totalité ; les autres rien ; tous les partisans d'une région terminée sont rendus.
- Une tuile présente plusieurs fois dans une région compte une fois. Les égalités au classement final sont conservées.

Les régions globales sont tenues par un Union-Find (union par taille). Chaque attribution produit un `ScoreEvent` détaillé, affiché dans le journal de la partie.

Écarts assumés : les phases `SCORE_FEATURES`, `END_TURN` et `DRAW_TILE` sont exécutées automatiquement (il n'y a pas d'action `END_TURN`) ; la phase partisan est sautée quand aucune pose n'est possible. Aucune extension commerciale.

## Bots

| Niveau | Principe |
|---|---|
| Facile | placement légal au hasard, partisans posés naïvement |
| Normal | glouton : points immédiats, régions terminées, économie de partisans |
| Difficile | valeur espérée de chaque région revendiquée pour chaque joueur : probabilité de fermeture (cases ouvertes et tuiles restantes qui s'y logent), majorités, prairies, abbayes, partisans en main, tours restants |
| Expert | Monte-Carlo par déterminisation : présélection stratégique, puis simulations où l'ordre des tuiles restantes est tiré par le bot |

Un bot ne reçoit qu'une **vue publique** : l'ordre de la pioche y est remplacé par le multiensemble trié des tuiles non vues. Sa décision est rejouée par les mêmes validateurs que celle d'un humain. Les calculs se font dans un Web Worker, avec budget de simulations, limite de temps et repli sur une action légale.

Résultats mesurés (`tests/bots.test.ts`) : Normal bat Facile 30–0 ; Difficile bat Normal 25–5 (100 contre 80 points en moyenne) ; Expert bat Normal 7–1 sur 8 parties. L'écart Expert/Difficile n'a pas été mesuré.

## Multijoueur

Architecture client–hôte : la machine hôte détient l'état de référence et le deck, valide chaque intention et diffuse l'action validée avec les tuiles qu'elle révèle. Les clients tiennent une réplique de l'état public par le même moteur.

- Messages JSON sur WebSocket ; chaque action porte session, joueur, numéro de séquence et révision attendue. Doublons ignorés, messages hors séquence ou périmés rejetés.
- Empreinte SHA-256 de l'état public après chaque action : une divergence déclenche un instantané (tuiles révélées + actions), jamais d'image.
- Salon : sièges, couleurs, « prêt », bots, réglages. Reconnexion par jeton ; un joueur absent peut être remplacé par un bot le temps de son absence.
- **Engagement** : l'hôte publie le SHA-256 de son secret, puis celui du deck ; chaque invité fournit de l'aléa qui entre dans la seed. À la fin, tout est révélé et chaque client vérifie automatiquement.

**Réseau local** : aucun service externe ; l'hôte affiche son adresse et un code de salon, qui n'est qu'une écriture compacte de `IPv4:port`.
**À distance** : l'hôte doit être joignable (redirection du port TCP sur le routeur, VPN ou tunnel). Il n'y a ni relais ni traversée de NAT. Le trafic est en `ws://`, non chiffré : à réserver à un réseau de confiance ou à un VPN.

**Limites du modèle d'équité** : l'hôte connaît l'ordre des tuiles et peut en tirer parti en jouant ; l'engagement détecte un deck modifié en cours de partie, pas cette connaissance. Un hôte peut aussi abandonner un salon dont le tirage ne lui convient pas. Ce n'est pas l'équivalent d'un serveur tiers de confiance.

L'hébergement n'existe que dans l'application de bureau ; un navigateur peut seulement rejoindre.

## Persistance et replays

Une sauvegarde contient la version du format, des règles et du générateur, les paramètres, le deck (`[identifiant, seed]` par tuile) et l'historique des actions. Plateau, régions, scores et images sont reconstruits par rejeu, puis comparés à l'empreinte enregistrée. Environ 5 Ko pour une partie de 40 tuiles à 3 joueurs, 9 Ko pour 72 tuiles.

Sauvegarde automatique à chaque tour (parties locales), sauvegarde manuelle, reprise, export et import (validés puis rejoués avant d'être acceptés), replay avec navigation et vitesses ×1 à ×16. Les sauvegardes d'un autre format sont migrées ou refusées avec un message explicite. Côté bureau, l'écriture est atomique (fichier temporaire, synchronisation, renommage) dans le dossier de données de l'application.

## Sécurité

- Permissions Tauri : écoute d'événements uniquement. Aucun accès au système de fichiers, au shell ni à HTTP depuis le frontend.
- Huit commandes natives ; noms de sauvegarde limités à `[A-Za-z0-9_-]{1,48}`, 4 Mo par fichier.
- Relais WebSocket : 16 connexions, 64 Ko par message entrant, file de sortie bornée, texte seulement.
- Content Security Policy restrictive ; aucun script distant, aucune télémétrie, aucun compte.
- Le solo fonctionne entièrement hors ligne.

## Tests

| Fichier | Contenu |
|---|---|
| `topology.test.ts` | 81 configurations, 24 classes, partitions, cités traversantes ou indépendantes, carrefours, portes, prairies |
| `geometry.test.ts` | toutes les topologies × 8 seeds, profils de bord, coins, validation à 256 px, déterminisme, ancres |
| `rules.test.ts` | scénarios de score chiffrés et règles de tour |
| `bots.test.ts` | légalité, absence d'information cachée, pureté, force relative |
| `determinism.test.ts` | vecteurs SHA-256, tests statistiques, decks, sauvegardes, replays, migrations |
| `multiplayer.test.ts` | salon, synchronisation, messages invalides, dupliqués, désordonnés, divergence, reconnexion, audit, fuite du deck |
| `simulation.test.ts` | 3 000 parties automatiques avec invariants recalculés, marches aléatoires contrôlées à chaque pas |
| `src-tauri` | stockage (validation des noms, écriture atomique), relais WebSocket (échanges, limites, fermeture) |

Résultat de la dernière exécution : 80 tests Vitest et 5 tests Rust réussis. Sur 3 000 parties, 191 610 tuiles posées, 55 défaussées (0,03 %).

L'interface et le dessin n'ont pas de tests automatisés ; ils ont été vérifiés à la main dans un navigateur (menu, configuration, partie contre bot, partie complète entre bots, fin de partie, sauvegarde automatique, replay, inspecteur, 81 configurations).

## Performances mesurées

Mesures sur la machine de développement (Windows 11, Node 26, WebView Chromium), à titre indicatif.

| Mesure | Résultat |
|---|---|
| Construction du catalogue (103 topologies) | quelques ms |
| Géométrie validée d'une tuile | ≈ 2,7 ms |
| Partie classique complète entre bots « Normal » | ≈ 50 ms |
| 3 000 parties headless | ≈ 35 s |
| Plateau de 500 tuiles : génération / clonage / placements légaux | 66 ms / 0,2 ms / 0,2 ms |
| Plateau de 1 000 tuiles : génération / clonage / placements légaux | 229 ms / 0,5 ms / 0,4 ms |
| Dessin d'une image, 500 tuiles visibles | 0,7 ms (médiane), 1,1 ms (p95) |
| Dessin d'une image, 1 000 tuiles visibles | 1,8 ms (médiane), 2,5 ms (p95) |
| Dessin d'une image au zoom nominal (≈ 70 tuiles) | 0,1 ms |
| Cache des tuiles à 64 px : 500 / 1 000 tuiles | 8,9 Mo / 16,6 Mo |
| Tas JavaScript avec 1 000 tuiles | ≈ 32 Mo |

Le dessin d'une image reste donc très en dessous des 16,7 ms d'un affichage à 60 images par seconde. Le premier affichage d'un grand plateau est progressif : les tuiles manquantes sont générées par tranches de 9 ms par image. Il a pris 1,0 s pour 500 tuiles et 9,6 s pour 1 000 dans le volet de prévisualisation utilisé, dont la cadence d'animation était bridée (≈ 14 à 30 images par seconde) ; ce chiffre n'a pas été mesuré dans la fenêtre Tauri.

## Tailles mesurées

`npm run measure` après `npm run tauri build` :

| Élément | Taille |
|---|---|
| Frontend complet (`dist/`, 4 fichiers) | 168,4 Ko bruts · 63,0 Ko gzip · 55,6 Ko brotli |
| dont JavaScript principal | 135,2 Ko · 50,7 Ko gzip |
| dont worker des bots | 25,0 Ko · 9,5 Ko gzip |
| dont CSS | 7,8 Ko · 2,6 Ko gzip |
| Images, polices, sons, vidéos embarqués | 0 fichier |
| Exécutable `bastides.exe` (release, LTO, `opt-level = "s"`, symboles retirés) | 3 251 Ko |
| Installateur NSIS `Bastides_0.1.0_x64-setup.exe` | 1 206 Ko |
| Sauvegarde d'une partie de 72 tuiles | ≈ 9 Ko |
| Mémoire du processus `bastides.exe` au menu | ≈ 25 Mo |
| Mémoire des processus WebView2 au menu (runtime système, 6 processus) | ≈ 360 Mo |

L'objectif de 500 Ko compressés pour le frontend est tenu avec une marge d'un facteur 8. L'exécutable contient le frontend et l'icône générée (32 Ko). Le runtime **WebView2** n'est pas dans ces tailles : il fait partie de Windows 10/11 ; s'il manque, l'installateur télécharge son programme d'amorçage. Sa mémoire est celle d'un moteur Chromium et dépasse de loin celle du jeu.

## Limitations connues

- Seul Windows x64 a été compilé. macOS et Linux demandent les ajustements indiqués plus haut et n'ont pas été testés.
- L'exécutable compilé a été lancé (fenêtre ouverte, processus réactif), mais son contenu n'a pas été inspecté : les écrans ont été vérifiés dans un navigateur, pas dans la fenêtre Tauri. La politique CSP, les sauvegardes sur disque et l'hébergement réseau restent donc à confirmer à la main dans l'application de bureau.
- Le multijoueur a été testé de bout en bout en mémoire (hôte et clients TypeScript) et le relais Rust par ses tests unitaires ; une partie entre deux machines réelles n'a pas été jouée dans cet environnement.
- Pas de relais ni de traversée de NAT ; trafic réseau non chiffré.
- L'avantage du premier joueur dans les parties miroir entre bots faciles est de 54,3 % sur 1 752 parties décidées, dans la bande de tolérance du test mais probablement réel (il joue un tour de plus sur 71 tirages).
- Le bot « Difficile » investit beaucoup dans les prairies ; son équilibre n'a été réglé que contre les autres bots.
- Pas de gestes tactiles (pincement), pas de traduction : l'interface est en français.
- Aux coins où deux cités indépendantes se touchent, un écart visuel de quelques pixels peut apparaître avec la tuile voisine ; il n'a aucun effet sur les règles.
- L'export par téléchargement dépend de la WebView ; la copie dans le presse-papiers est toujours proposée.
