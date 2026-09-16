/**
 * Calcule, pour chaque championnat, trois catégories d'équipes à partir
 * de leurs 8 derniers matchs :
 *   - invaincues        : série en cours sans défaite (V ou N)
 *   - quiMarquent       : série en cours avec ≥ 2 buts marqués par match
 *   - quiEncaissent     : série en cours avec ≥ 2 buts encaissés par match
 *
 * Une série se compte à partir du match le plus récent, en remontant,
 * et s'arrête au premier match qui ne respecte pas la condition.
 * Seules les séries d'au moins 3 matchs sont conservées (max 8, puisqu'on
 * ne regarde que les 8 derniers matchs).
 *
 * Source : football-data.org (API v4, offre gratuite).
 * Sortie  : data/invaincus.json
 *
 * Lancement local :  FOOTBALL_DATA_TOKEN=xxx node scripts/build-data.mjs
 * En production   :  déclenché par .github/workflows/update-data.yml
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, "..", "data", "invaincus.json");

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
if (!TOKEN) {
  console.error("Variable FOOTBALL_DATA_TOKEN absente. Ajoute ta clé API et relance.");
  process.exit(1);
}

/** Fenêtre d'analyse : les 8 derniers matchs de chaque équipe. */
const FENETRE = 8;
/** Longueur minimale d'une série pour être affichée. */
const SERIE_MIN = 3;
/** Seuil de buts pour "marque beaucoup" / "encaisse beaucoup". */
const SEUIL_BUTS = 2;

/**
 * Compétitions incluses dans l'offre gratuite de football-data.org.
 * Retire une ligne pour exclure une compétition du site.
 */
const COMPETITIONS = [
  { code: "PL", nom: "Premier League", pays: "Angleterre" },
  { code: "PD", nom: "La Liga", pays: "Espagne" },
  { code: "SA", nom: "Serie A", pays: "Italie" },
  { code: "BL1", nom: "Bundesliga", pays: "Allemagne" },
  { code: "FL1", nom: "Ligue 1", pays: "France" },
  { code: "DED", nom: "Eredivisie", pays: "Pays-Bas" },
  { code: "PPL", nom: "Primeira Liga", pays: "Portugal" },
  { code: "ELC", nom: "Championship", pays: "Angleterre" },
  { code: "BSA", nom: "Série A", pays: "Brésil" },
];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Appel API avec gestion du quota (10 requêtes/minute en offre gratuite).
 * En cas de 429, on attend et on retente jusqu'à 3 fois.
 */
async function appelApi(url, essai = 1) {
  const reponse = await fetch(url, { headers: { "X-Auth-Token": TOKEN } });

  if (reponse.status === 429 && essai <= 3) {
    const attente = 65_000;
    console.warn(`Quota atteint. Nouvelle tentative dans ${attente / 1000}s…`);
    await pause(attente);
    return appelApi(url, essai + 1);
  }

  if (!reponse.ok) {
    throw new Error(`${reponse.status} ${reponse.statusText} sur ${url}`);
  }

  return reponse.json();
}

/** Récupère tous les matchs terminés de la saison en cours pour une compétition. */
async function matchsTermines(code) {
  const url = `https://api.football-data.org/v4/competitions/${code}/matches?status=FINISHED`;
  const data = await appelApi(url);
  return data.matches ?? [];
}

/** Récupère les prochains matchs programmés d'une équipe (toutes compétitions confondues). */
async function prochainsMatchs(idEquipe, limite = 3) {
  const url = `https://api.football-data.org/v4/teams/${idEquipe}/matches?status=SCHEDULED&limit=${limite}`;
  const data = await appelApi(url);

  return (data.matches ?? []).map((match) => ({
    date: match.utcDate,
    competition: match.competition?.name ?? "—",
    domicile: match.homeTeam?.shortName || match.homeTeam?.name || "—",
    exterieur: match.awayTeam?.shortName || match.awayTeam?.name || "—",
  }));
}

/**
 * Construit l'historique de chaque équipe à partir de la liste des matchs.
 * Renvoie une Map : id équipe -> { nom, blason, rencontres[] }
 */
function historiqueParEquipe(matchs) {
  const equipes = new Map();

  for (const match of matchs) {
    const butsDom = match.score?.fullTime?.home;
    const butsExt = match.score?.fullTime?.away;
    if (butsDom === null || butsExt === null || butsDom === undefined || butsExt === undefined) {
      continue; // score indisponible (match reporté, annulé…)
    }

    const cotes = [
      { equipe: match.homeTeam, adverse: match.awayTeam, pour: butsDom, contre: butsExt, domicile: true },
      { equipe: match.awayTeam, adverse: match.homeTeam, pour: butsExt, contre: butsDom, domicile: false },
    ];

    for (const { equipe, adverse, pour, contre, domicile } of cotes) {
      if (!equipe?.id) continue;

      if (!equipes.has(equipe.id)) {
        equipes.set(equipe.id, {
          id: equipe.id,
          nom: equipe.shortName || equipe.name,
          blason: equipe.crest ?? null,
          rencontres: [],
        });
      }

      equipes.get(equipe.id).rencontres.push({
        date: match.utcDate,
        adversaire: adverse?.shortName || adverse?.name || "—",
        domicile,
        butsPour: pour,
        butsContre: contre,
        score: `${pour}-${contre}`,
        issue: pour > contre ? "V" : pour === contre ? "N" : "D",
      });
    }
  }

  return equipes;
}

/**
 * Compte, en partant du match le plus récent et en remontant, combien de
 * matchs consécutifs respectent `condition`. S'arrête au premier échec.
 */
function longueurSerie(recents, condition) {
  let n = 0;
  for (let i = recents.length - 1; i >= 0; i--) {
    if (!condition(recents[i])) break;
    n++;
  }
  return n;
}

/**
 * Analyse une équipe sur sa fenêtre des 8 derniers matchs et renvoie ses
 * trois séries. `recents` doit déjà être trié du plus ancien au plus récent
 * et limité à FENETRE matchs.
 */
function analyserEquipe(equipe, recents, competition) {
  const base = {
    id: equipe.id,
    nom: equipe.nom,
    blason: equipe.blason,
    competition: competition.nom,
    pays: competition.pays,
    dernierMatch: recents.at(-1).date,
    detail: recents,
  };

  return {
    invaincue: {
      ...base,
      serie: longueurSerie(recents, (m) => m.issue !== "D"),
    },
    marque: {
      ...base,
      serie: longueurSerie(recents, (m) => m.butsPour >= SEUIL_BUTS),
    },
    encaisse: {
      ...base,
      serie: longueurSerie(recents, (m) => m.butsContre >= SEUIL_BUTS),
    },
  };
}

/** Trie par série décroissante, puis par nom pour un ordre stable. */
function trierParSerie(liste) {
  return [...liste].sort((a, b) => b.serie - a.serie || a.nom.localeCompare(b.nom));
}

async function main() {
  const invaincues = [];
  const quiMarquent = [];
  const quiEncaissent = [];
  const echecs = [];

  for (const competition of COMPETITIONS) {
    try {
      console.log(`Lecture de ${competition.nom}…`);
      const matchs = await matchsTermines(competition.code);
      const historique = historiqueParEquipe(matchs);
      let retenuesInvaincue = 0, retenuesMarque = 0, retenuesEncaisse = 0;

      for (const equipe of historique.values()) {
        const recents = equipe.rencontres
          .sort((a, b) => new Date(a.date) - new Date(b.date))
          .slice(-FENETRE);

        if (recents.length < FENETRE) continue; // pas assez d'historique cette saison

        const { invaincue, marque, encaisse } = analyserEquipe(equipe, recents, competition);

        if (invaincue.serie >= SERIE_MIN) { invaincues.push(invaincue); retenuesInvaincue++; }
        if (marque.serie >= SERIE_MIN)   { quiMarquent.push(marque);   retenuesMarque++; }
        if (encaisse.serie >= SERIE_MIN) { quiEncaissent.push(encaisse); retenuesEncaisse++; }
      }

      console.log(`  ${matchs.length} matchs analysés — invaincues: ${retenuesInvaincue}, marquent: ${retenuesMarque}, encaissent: ${retenuesEncaisse}`);
    } catch (erreur) {
      console.error(`  Échec sur ${competition.nom} : ${erreur.message}`);
      echecs.push(competition.nom);
    }
    await pause(6_500); // reste sous les 10 requêtes/minute
  }

  // Une même équipe peut apparaître dans plusieurs catégories : on ne va
  // chercher ses prochains matchs qu'une seule fois.
  const equipesUniques = new Map();
  for (const e of [...invaincues, ...quiMarquent, ...quiEncaissent]) {
    if (!equipesUniques.has(e.id)) equipesUniques.set(e.id, e.nom);
  }

  const prochainsParEquipe = new Map();
  for (const [id, nom] of equipesUniques) {
    try {
      prochainsParEquipe.set(id, await prochainsMatchs(id));
    } catch (erreur) {
      console.error(`  Impossible de récupérer les prochains matchs de ${nom} : ${erreur.message}`);
      prochainsParEquipe.set(id, []);
    }
    await pause(6_500);
  }

  for (const e of [...invaincues, ...quiMarquent, ...quiEncaissent]) {
    e.prochainsMatchs = prochainsParEquipe.get(e.id) ?? [];
  }

  const sortie = {
    genereLe: new Date().toISOString(),
    fenetre: FENETRE,
    serieMin: SERIE_MIN,
    seuilButs: SEUIL_BUTS,
    competitionsAnalysees: COMPETITIONS.filter((c) => !echecs.includes(c.nom)).map((c) => c.nom),
    competitionsEnEchec: echecs,
    invaincues: trierParSerie(invaincues),
    quiMarquent: trierParSerie(quiMarquent),
    quiEncaissent: trierParSerie(quiEncaissent),
  };

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(sortie, null, 2), "utf8");
  console.log(
    `\nTerminé : ${sortie.invaincues.length} invaincues, ${sortie.quiMarquent.length} qui marquent, ` +
    `${sortie.quiEncaissent.length} qui encaissent → data/invaincus.json`
  );
}

main().catch((erreur) => {
  console.error(erreur);
  process.exit(1);
});
