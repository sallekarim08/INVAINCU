/**
 * Calcule les équipes invaincues sur leurs 8 derniers matchs.
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

/** Nombre de matchs consécutifs sans défaite exigé. */
const SERIE = 8;

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
        score: `${pour}-${contre}`,
        issue: pour > contre ? "V" : pour === contre ? "N" : "D",
      });
    }
  }

  return equipes;
}

/** Ne garde que les équipes dont les 8 derniers matchs ne comptent aucune défaite. */
function filtrerInvaincues(equipes, competition) {
  const retenues = [];

  for (const equipe of equipes.values()) {
    const recents = equipe.rencontres
      .sort((a, b) => new Date(a.date) - new Date(b.date)) // du plus ancien au plus récent
      .slice(-SERIE);

    if (recents.length < SERIE) continue;
    if (recents.some((r) => r.issue === "D")) continue;

    retenues.push({
      id: equipe.id,
      nom: equipe.nom,
      blason: equipe.blason,
      competition: competition.nom,
      pays: competition.pays,
      forme: recents.map((r) => r.issue),
      victoires: recents.filter((r) => r.issue === "V").length,
      nuls: recents.filter((r) => r.issue === "N").length,
      butsMarques: recents.reduce((t, r) => t + Number(r.score.split("-")[0]), 0),
      butsEncaisses: recents.reduce((t, r) => t + Number(r.score.split("-")[1]), 0),
      dernierMatch: recents.at(-1).date,
      detail: recents,
    });
  }

  return retenues;
}

async function main() {
  const invaincues = [];
  const echecs = [];

  for (const competition of COMPETITIONS) {
    try {
      console.log(`Lecture de ${competition.nom}…`);
      const matchs = await matchsTermines(competition.code);
      const trouvees = filtrerInvaincues(historiqueParEquipe(matchs), competition);
      console.log(`  ${matchs.length} matchs analysés, ${trouvees.length} équipe(s) retenue(s)`);
      invaincues.push(...trouvees);
    } catch (erreur) {
      console.error(`  Échec sur ${competition.nom} : ${erreur.message}`);
      echecs.push(competition.nom);
    }
    await pause(6_500); // reste sous les 10 requêtes/minute
  }

  // Tri : le plus de victoires d'abord, puis la meilleure différence de buts
  invaincues.sort(
    (a, b) =>
      b.victoires - a.victoires ||
      b.butsMarques - b.butsEncaisses - (a.butsMarques - a.butsEncaisses)
  );

  const sortie = {
    genereLe: new Date().toISOString(),
    serieExigee: SERIE,
    competitionsAnalysees: COMPETITIONS.filter((c) => !echecs.includes(c.nom)).map((c) => c.nom),
    competitionsEnEchec: echecs,
    equipes: invaincues,
  };

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(sortie, null, 2), "utf8");
  console.log(`\n${invaincues.length} équipe(s) invaincue(s) sur ${SERIE} matchs → data/invaincus.json`);
}

main().catch((erreur) => {
  console.error(erreur);
  process.exit(1);
});
