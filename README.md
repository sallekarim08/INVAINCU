# Invaincus — 8 matchs sans défaite

Site qui liste uniquement les équipes n'ayant subi aucune défaite sur leurs huit derniers matchs de championnat. Données réelles, hébergement et exécution gratuits, aucun serveur à maintenir.

## Comment ça marche

```
GitHub Actions (toutes les 6 h)
   │  appelle football-data.org avec la clé API
   ▼
scripts/build-data.mjs  ──►  data/invaincus.json  (commité dans le dépôt)
                                   │
                                   ▼
                          index.html sur GitHub Pages
```

La clé API vit dans les secrets GitHub : elle n'apparaît jamais dans le code du site.

## Installation

### 1. Obtenir une clé API

Créer un compte sur [football-data.org](https://www.football-data.org/client/register). L'offre gratuite couvre les neuf championnats configurés, avec une limite de dix requêtes par minute — le script la respecte automatiquement.

### 2. Créer le dépôt

Pousser ces fichiers dans un dépôt GitHub **public** (les Actions et Pages sont gratuits sans limite sur les dépôts publics).

### 3. Enregistrer la clé

Dans le dépôt : **Settings → Secrets and variables → Actions → New repository secret**

- Nom : `FOOTBALL_DATA_TOKEN`
- Valeur : la clé reçue par e-mail

### 4. Publier le site

**Settings → Pages → Source : Deploy from a branch**, branche `main`, dossier `/ (root)`.

### 5. Première génération

**Actions → Rafraîchir les données → Run workflow.** Le fichier `data/invaincus.json` est créé et commité. Le site est en ligne.

## Réglages

| Ce que tu veux changer | Où |
|---|---|
| La longueur de la série (8 matchs) | `SERIE` en haut de `scripts/build-data.mjs` |
| Les championnats suivis | tableau `COMPETITIONS`, même fichier |
| La fréquence de mise à jour | ligne `cron` dans `.github/workflows/update-data.yml` |
| Le tri des équipes | fonction `invaincues.sort(...)` en fin de script |

## Points à connaître

- La série est calculée **par championnat** : les matchs de coupe et de Coupe d'Europe ne sont pas comptés. C'est le choix le plus lisible, et le seul possible avec l'offre gratuite.
- Une équipe ayant disputé moins de huit matchs dans la saison n'apparaît pas. En début de saison, la liste peut donc être vide — c'est normal, pas un bug.
- Si une compétition échoue (quota, indisponibilité), les autres sont quand même publiées et l'échec est noté dans `competitionsEnEchec` du JSON.

## Test en local

```bash
FOOTBALL_DATA_TOKEN=ta_cle node scripts/build-data.mjs
python3 -m http.server 8000   # puis ouvrir http://localhost:8000
```
