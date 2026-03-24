# Montreal Transit Atlas

SPA `React + TypeScript + Vite` pour visualiser le réseau STM / métro / REM sur une carte interactive, avec fonctions Netlify, recherche, filtres, et favoris synchronisés via Netlify Identity.

## Ce que fait la V1
- vue combinée `bus + métro + REM`
- filtres par mode
- recherche `lignes + stations`
- carte `2D` et `aérien` si une clé MapTiler est fournie
- favoris synchronisés côté compte
- bus `temps réel` quand le flux STM GTFS-RT est configuré
- métro et REM `estimés` ou `statut seulement` selon la source disponible
- endpoint `BIXI` temps réel via le flux officiel GBFS
- géocodage `adresse -> coordonnées`
- planificateur backend `adresse -> adresse` avec modes `walking`, `transit`, `bixi`

## Stack
- `React 19`
- `Vite`
- `MapLibre GL JS`
- `Netlify Functions`
- `Netlify Identity`
- `Netlify Blobs`

## Démarrage
1. Installer les dépendances :

```bash
npm install
```

2. Copier les variables d’environnement :

```bash
cp .env.example .env
```

3. Lancer en local avec Netlify :

```bash
npm run dev:netlify
```

L’app sera servie sur [http://localhost:8888](http://localhost:8888).

## Variables d’environnement
### Carte
- `VITE_MAPTILER_API_KEY`
  Active les styles `2D` et `Aérien` MapTiler côté frontend.
- `MAPTILER_API_KEY`
  Utilisée côté fonctions pour le géocodage adresse.

### Routage adresse -> adresse
- `ORS_API_KEY`
  Optionnelle. Si fournie, active des tracés et durées de marche/vélo plus fiables via OpenRouteService. Sans elle, le backend renvoie des estimations propres mais sans routage détaillé.

### BIXI
- `BIXI_GBFS_URL`
  Valeur par défaut testée : `https://gbfs.velobixi.com/gbfs/gbfs.json`

### Bus STM temps réel
- `STM_BUS_VEHICLE_POSITIONS_URL`
  URL GTFS-RT des positions de véhicules STM. Valeur testée : `https://api.stm.info/pub/od/gtfs-rt/ic/v2/vehiclePositions`
- `STM_API_KEY`
  Clé STM `API Key / Client ID`.
- `STM_API_KEY_HEADER`
  Header utilisé pour la clé si la STM attend un header. Défaut : `apikey`.
- `STM_API_KEY_QUERY_PARAM`
  Nom du query param si la clé doit être ajoutée dans l’URL au lieu du header.

## Scripts utiles
- `npm run dev`
  Frontend Vite seul.
- `npm run dev:netlify`
  Frontend + fonctions Netlify + snapshot réseau.
- `npm run prepare:data`
  Génère `generated/network-model.json` à partir des GTFS STM/REM.
- `npm run build`
  Génère le snapshot réseau puis build l’app.
- `npm run lint`
  Lance ESLint.
- `npm run check`
  Lance lint + build.

## Endpoints backend
- `GET /api/bootstrap`
  Réseau STM / métro / REM normalisé.
- `GET /api/live?modes=bus,metro,rem`
  Entités live STM / métro / REM.
- `GET /api/bixi?availableOnly=1`
  Stations BIXI temps réel + alertes.
- `GET /api/geocode?q=...&limit=5`
  Suggestions d’adresses/lieux géocodés.
- `GET /api/plan?from=...&to=...&modes=walking,transit,bixi`
  Itinéraires estimés `adresse -> adresse`.
- `POST /api/plan`
  Même logique, en JSON. Supporte aussi `fromLat`, `fromLon`, `toLat`, `toLon`.
- `GET /api/favorites`
  Favoris du compte connecté.
- `PUT /api/favorites`
  Remplace la liste des favoris du compte connecté.

## Déploiement Netlify
1. Créer le site sur Netlify.
2. Définir les variables d’environnement listées plus haut.
3. Activer `Identity` si tu veux les favoris synchronisés.
4. Déployer avec la commande build déjà définie dans [`netlify.toml`](/Users/pierre-briacmetayer/Desktop/interactive%20map/netlify.toml).

## Notes importantes
- Le fichier `generated/network-model.json` est un snapshot pré-généré pour éviter de télécharger et parser les GTFS au premier appel de fonction.
- Sans configuration STM GTFS-RT, la carte reste utilisable mais les bus n’auront pas de positions temps réel.
- Sans clé MapTiler, la vue `Aérien` est désactivée et la carte retombe sur un style OSM 2D.
- Le métro STM et le REM sont affichés comme `estimés` ou `statut seulement`, jamais comme positions exactes confirmées.
- Le planificateur backend est le plus fiable si le frontend utilise d’abord `/api/geocode` puis envoie les coordonnées choisies à `/api/plan`, au lieu d’envoyer uniquement une chaîne d’adresse libre.
