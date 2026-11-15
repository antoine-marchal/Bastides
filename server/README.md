# Bastides — serveur relais

Relais HTTP minimal pour les parties **en ligne**. Aucune dépendance, aucune étape de build.

Le serveur **n'exécute pas le jeu** : l'application de l'hôte reste l'arbitre (elle détient le
deck secret et valide chaque action). Le relais ne fait que transporter des messages texte entre
l'hôte et ses invités, par *long-polling* HTTP — ce qui lui permet de tourner sur des plateformes
serverless (Vercel…) qui ne gardent pas de WebSocket ouvert.

## Déployer sur Vercel

### Avec le script (Windows)

```bat
server\deploy-vercel.bat          :: déploiement de production
server\deploy-vercel.bat preview  :: déploiement d'aperçu (URL séparée)
```

Le script utilise la CLI Vercel via `npx` (rien à installer à part Node ≥ 18). Au premier lancement
elle demande de se connecter puis de lier un projet : accepter les valeurs proposées (pas de
framework, pas de commande de build).

Ensuite, **une seule fois** : tableau de bord Vercel → le projet → *Storage* → *Upstash for Redis*
→ *Connect* (offre gratuite suffisante), puis relancer `deploy-vercel.bat` pour que les variables
soient prises en compte.

### Depuis le tableau de bord (import Git)

1. *Add New → Project*, importer le dépôt, **Root Directory = `server`**, Framework *Other*,
   aucune commande de build.
2. *Storage* → *Upstash for Redis* → *Connect*. L'intégration définit `KV_REST_API_URL` /
   `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`), lus automatiquement.
3. Redéployer.

### Vérifier

Ouvrir `https://<projet>.vercel.app/health` → `{"ok":true,…,"store":"upstash-redis"}`.
Dans le jeu : *Multijoueur → En ligne → Serveur* = `https://<projet>.vercel.app`, puis
*Créer un salon en ligne* ; les autres joueurs saisissent le même serveur et le code à 6 caractères.

Redis est **indispensable sur Vercel** : deux requêtes successives peuvent atteindre deux instances
différentes, la mémoire ne peut donc pas être partagée. Si `/health` indique `"store":"memory"`, les
variables Redis ne sont pas configurées.

## Lancer ailleurs (Node ≥ 18)

```bat
server\start-server.bat         :: port 8787, stockage en mémoire
server\start-server.bat 9000    :: autre port
```

ou, sur n'importe quel système :

```bash
cd server
PORT=8787 node server.js
```

Un seul processus suffit (VPS, Render, Fly.io, Raspberry Pi…). En local, saisir `localhost:8787`
comme serveur dans l'écran Multijoueur → En ligne.

## API

| Méthode | Chemin | Rôle |
|---|---|---|
| `POST` | `/rooms` | crée un salon → `{ room, key }` (l'appelant est l'hôte) |
| `POST` | `/rooms/:room/join` | rejoint un salon → `{ conn, key }` |
| `POST` | `/rooms/:room/send` | `{ key, frames }` — hôte : `[{ to, text }]`, invité : `["…"]` |
| `GET` | `/rooms/:room/poll?key=…&after=n` | lit sa boîte (attente jusqu'à 8 s avec Redis, 25 s en mémoire) |
| `POST` | `/rooms/:room/leave` | `{ key }` — un invité part / l'hôte ferme le salon |
| `GET` | `/health` | état du service |

Codes de salon : 6 caractères sans ambiguïté (pas de I, O, 0, 1). Les clés sont des secrets
aléatoires de 128 bits : connaître le code permet seulement de rejoindre le salon. Un invité
silencieux depuis 30 s est signalé déconnecté à l'hôte (qui peut le faire remplacer par un bot) ;
il revient avec son jeton de session. Les salons expirent après 6 h.

**Coût Redis** : chaque attente consomme environ une commande par seconde et par joueur connecté
(~15 000 commandes pour une partie d'une heure à quatre).
