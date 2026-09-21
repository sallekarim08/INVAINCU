/**
 * Calcule, pour chaque championnat :
 *   - six catégories d'équipes (séries en cours) ;
 *   - les rencontres à venir (fixtures) ;
 *   - les probabilités « Stratège » pour le prochain match de championnat
 *     des équipes des catégories invaincue / marque beaucoup / marque toujours.
 *
 * CATÉGORIES (séries en cours, calculées à partir du match le plus récent) :
 *   - invaincues          : V ou N                    — fenêtre 8,  seuil buts —
 *   - quiMarquent         : ≥ 2 buts marqués           — fenêtre 8,  seuil buts 2
 *   - quiEncaissent       : ≥ 2 buts encaissés         — fenêtre 8,  seuil buts 2
 *   - marqueToujours      : ≥ 1 but marqué             — fenêtre 10, seuil buts 1
 *   - encaisseToujours    : ≥ 1 but encaissé           — fenêtre 10, seuil buts 1
 *   - btts                : les deux équipes marquent  — fenêtre 8,  seuil buts —
 *
 * STRATÈGE — méthode (volontairement simple et documentée, aucune valeur inventée) :
 *   λ_marque(équipe)   = moyenne des buts marqués par l'équipe sur sa fenêtre récente
 *   λ_encaisse(équipe) = moyenne des buts encaissés par l'équipe sur sa fenêtre récente
 *   λ_effectif(équipe face à adversaire) = (λ_marque(équipe) + λ_encaisse(adversaire)) / 2
 *   Ensuite, loi de Poisson : P(X = k) = e^-λ · λ^k / k!
 *     - « marque toujours »  → P(X ≥ 1) = 1 − P(0)
 *     - « marque beaucoup »  → P(X ≥ 2) = 1 − P(0) − P(1)
 *     - « invaincue »        → on calcule λ_effectif pour les DEUX équipes, on construit
 *                              la grille des scores possibles (0 à 6 buts chacune) et on
 *                              additionne les cas où l'équipe ne perd pas (victoire + nul).
 *   Le prochain match est cherché UNIQUEMENT dans le même championnat (jamais coupe,
 *   Ligue des champions ou amical). Sans match de championnat trouvé, l'équipe est
 *   marquée « aucun prochain match de championnat programmé ».
 *   Fiabilité : moins de 3 matchs exploitables (équipe ou adversaire) → équipe exclue ;
 *   entre 3 et (fenêtre − 1) → « échantillon réduit » ; fenêtre complète → « calcul normal ».
 *
 * SUIVI DE FIABILITÉ — chaque pronostic « ok » du jour est enregistré dans
 * data/historique-predictions.json (un fichier séparé, conservé d'une exécution à l'autre
 * puisqu'il est commité dans le dépôt comme data/invaincus.json). À chaque exécution :
 *   1. le pronostic du jour pour chaque match à venir est noté (ou mis à jour tant que
 *      le match n'a pas eu lieu) ;
 *   2. les pronostics dont le match est maintenant terminé sont comparés au résultat réel
 *      et marqués « réussi » ou « échoué » ;
 *   3. un pronostic dont le match n'apparaît toujours pas joué 4 jours après la date prévue
 *      est marqué « indéterminé » (report ou annulation probable) et sorti du calcul du taux ;
 *   4. un taux de réussite global et par catégorie est recalculé et ajouté à la sortie.
 *
 * Source : football-data.org (API v4, offre gratuite).
 * Sortie  : data/invaincus.json + data/historique-predictions.json
 *
 * Lancement local :  FOOTBALL_DATA_TOKEN=xxx node scripts/build-data.mjs
 * En production   :  déclenché par .github/workflows/update-data.yml
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, "..", "data", "invaincus.json");
const HISTORIQUE_PREDICTIONS = resolve(__dirname, "..", "data", "historique-predictions.json");

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
if (!TOKEN) {
  console.error("Variable FOOTBALL_DATA_TOKEN absente. Ajoute ta clé API et relance.");
  process.exit(1);
}

/** Longueur minimale d'une série pour être affichée, quelle que soit la catégorie. */
const SERIE_MIN = 3;

/** Nombre de jours à l'avance pour lesquels on récupère les rencontres à venir. */
const JOURS_A_VENIR = 21;

/** Passé ce délai après la date prévue sans trouver le match joué, on abandonne (report/annulation probable). */
const JOURS_AVANT_INDETERMINE = 4;

/**
 * Définition des six catégories. Chacune a sa propre fenêtre d'analyse
 * (nombre de derniers matchs regardés) et son propre critère match par match.
 */
const CATEGORIES = [
  { cle: "invaincues",       fenetre: 8,  condition: (m) => m.issue !== "D" },
  { cle: "quiMarquent",      fenetre: 8,  condition: (m) => m.butsPour   >= 2 },
  { cle: "quiEncaissent",    fenetre: 8,  condition: (m) => m.butsContre >= 2 },
  { cle: "marqueToujours",   fenetre: 10, condition: (m) => m.butsPour   >= 1 },
  { cle: "encaisseToujours", fenetre: 10, condition: (m) => m.butsContre >= 1 },
  { cle: "btts",             fenetre: 8,  condition: (m) => m.butsPour >= 1 && m.butsContre >= 1 },
];

/** Les quatre catégories pour lesquelles le module Stratège calcule une probabilité. */
const CATEGORIES_STRATEGE = ["invaincues", "quiMarquent", "marqueToujours", "btts"];

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

/** Récupère les matchs programmés d'une compétition dans les JOURS_A_VENIR prochains jours. */
async function matchsAVenir(code) {
  const aujourdhui = new Date();
  // dateTo est EXCLU par l'API (documentation officielle) : on ajoute donc un jour de plus
  // pour couvrir réellement les JOURS_A_VENIR prochains jours en entier.
  const finFenetre = new Date(aujourdhui.getTime() + (JOURS_A_VENIR + 1) * 86_400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url = `https://api.football-data.org/v4/competitions/${code}/matches?status=SCHEDULED&dateFrom=${fmt(aujourdhui)}&dateTo=${fmt(finFenetre)}`;
  const data = await appelApi(url);
  return data.matches ?? [];
}

/**
 * Construit l'historique de chaque équipe à partir de la liste des matchs.
 * Renvoie une Map : id équipe -> { nom, blason, rencontres[] }
 * `rencontres` contient TOUS les matchs de la saison, triés du plus ancien
 * au plus récent — chaque catégorie découpe ensuite la fenêtre qui lui correspond.
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

  for (const equipe of equipes.values()) {
    equipe.rencontres.sort((a, b) => new Date(a.date) - new Date(b.date));
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

/** Trie par série décroissante, puis par nom pour un ordre stable. */
function trierParSerie(liste) {
  return [...liste].sort((a, b) => b.serie - a.serie || a.nom.localeCompare(b.nom));
}

/** Moyenne de buts marqués / encaissés sur une fenêtre de matchs. */
function moyenneButs(recents, cle) {
  if (!recents.length) return 0;
  return recents.reduce((total, m) => total + m[cle], 0) / recents.length;
}

/** Probabilité de Poisson P(X = k) pour un paramètre λ donné. */
function poisson(k, lambda) {
  let factorielle = 1;
  for (let i = 2; i <= k; i++) factorielle *= i;
  return (Math.exp(-lambda) * lambda ** k) / factorielle;
}

/**
 * Niveau de fiabilité selon le plus petit nombre de matchs exploitables
 * (équipe ou adversaire, celui qui a le moins de recul).
 */
function fiabilite(nEquipe, nAdversaire, fenetreRef) {
  const n = Math.min(nEquipe, nAdversaire);
  if (n < SERIE_MIN) return null; // exclu
  if (n < fenetreRef) return "Échantillon réduit";
  return "Calcul normal";
}

/**
 * Cherche, dans la liste des rencontres à venir de la compétition, le PROCHAIN
 * match de cette équipe (championnat uniquement, jamais une autre compétition).
 */
function prochainMatchChampionnat(idEquipe, fixturesCompetition) {
  const matchs = fixturesCompetition
    .filter((m) => m.homeTeam?.id === idEquipe || m.awayTeam?.id === idEquipe)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  if (!matchs.length) return null;

  const m = matchs[0];
  const domicile = m.homeTeam?.id === idEquipe;
  return {
    date: m.utcDate,
    domicile,
    adversaireId: domicile ? m.awayTeam?.id : m.homeTeam?.id,
    adversaireNom: domicile
      ? (m.awayTeam?.shortName || m.awayTeam?.name)
      : (m.homeTeam?.shortName || m.homeTeam?.name),
  };
}

/** Construit l'entrée Stratège pour une équipe d'une des trois catégories concernées. */
function calculerStratege(categorieCle, equipeEntree, historique, fixturesCompetition, fenetreCategorie) {
  const base = {
    id: equipeEntree.id,
    nom: equipeEntree.nom,
    blason: equipeEntree.blason,
    competition: equipeEntree.competition,
  };

  const equipeComplete = historique.get(equipeEntree.id);
  const prochain = prochainMatchChampionnat(equipeEntree.id, fixturesCompetition);

  if (!prochain) {
    return { ...base, statut: "aucun_prochain_match" };
  }

  const adversaireComplet = historique.get(prochain.adversaireId);
  if (!adversaireComplet) {
    // L'adversaire n'a aucun match terminé enregistré cette saison : pas de base de calcul fiable.
    return { ...base, statut: "donnees_insuffisantes", adversaire: prochain.adversaireNom, date: prochain.date };
  }

  const recentsEquipe = equipeComplete.rencontres.slice(-fenetreCategorie);
  const recentsAdversaire = adversaireComplet.rencontres.slice(-fenetreCategorie);

  const niveauFiabilite = fiabilite(recentsEquipe.length, recentsAdversaire.length, fenetreCategorie);
  if (!niveauFiabilite) {
    return { ...base, statut: "donnees_insuffisantes", adversaire: prochain.adversaireNom, date: prochain.date };
  }

  const infosCommunes = {
    ...base,
    statut: "ok",
    adversaire: prochain.adversaireNom,
    domicile: prochain.domicile,
    date: prochain.date,
    fiabilite: niveauFiabilite,
    matchsUtilisesEquipe: recentsEquipe.length,
    matchsUtilisesAdversaire: recentsAdversaire.length,
  };

  if (categorieCle === "quiMarquent" || categorieCle === "marqueToujours") {
    const lambdaMarqueEquipe = moyenneButs(recentsEquipe, "butsPour");
    const lambdaEncaisseAdversaire = moyenneButs(recentsAdversaire, "butsContre");
    const lambda = (lambdaMarqueEquipe + lambdaEncaisseAdversaire) / 2;

    const probabilite = categorieCle === "marqueToujours"
      ? 1 - poisson(0, lambda)
      : 1 - poisson(0, lambda) - poisson(1, lambda);

    return {
      ...infosCommunes,
      lambda: Math.round(lambda * 100) / 100,
      probabilite: Math.round(probabilite * 1000) / 10, // en %, 1 décimale
    };
  }

  // categorieCle === "invaincues" ou "btts" : les deux nécessitent le λ des DEUX équipes.
  const lambdaEquipe = (moyenneButs(recentsEquipe, "butsPour") + moyenneButs(recentsAdversaire, "butsContre")) / 2;
  const lambdaAdversaire = (moyenneButs(recentsAdversaire, "butsPour") + moyenneButs(recentsEquipe, "butsContre")) / 2;

  if (categorieCle === "btts") {
    // P(les deux marquent) = P(équipe marque ≥ 1) × P(adversaire marque ≥ 1)
    const probabilite = (1 - poisson(0, lambdaEquipe)) * (1 - poisson(0, lambdaAdversaire));
    return {
      ...infosCommunes,
      lambdaEquipe: Math.round(lambdaEquipe * 100) / 100,
      lambdaAdversaire: Math.round(lambdaAdversaire * 100) / 100,
      probabilite: Math.round(probabilite * 1000) / 10,
    };
  }

  // categorieCle === "invaincues" : probabilité de ne pas perdre (victoire + nul)
  const MAX_BUTS = 6;
  let probaVictoire = 0, probaNul = 0;
  for (let i = 0; i <= MAX_BUTS; i++) {
    for (let j = 0; j <= MAX_BUTS; j++) {
      const p = poisson(i, lambdaEquipe) * poisson(j, lambdaAdversaire);
      if (i > j) probaVictoire += p;
      else if (i === j) probaNul += p;
    }
  }

  return {
    ...infosCommunes,
    lambdaEquipe: Math.round(lambdaEquipe * 100) / 100,
    lambdaAdversaire: Math.round(lambdaAdversaire * 100) / 100,
    probabilite: Math.round((probaVictoire + probaNul) * 1000) / 10,
  };
}

/** Charge l'historique des pronostics déjà enregistrés (fichier vide si premier lancement). */
async function chargerHistoriquePredictions() {
  try {
    const contenu = await readFile(HISTORIQUE_PREDICTIONS, "utf8");
    const donnees = JSON.parse(contenu);
    return Array.isArray(donnees.predictions) ? donnees.predictions : [];
  } catch {
    return [];
  }
}

/**
 * Enregistre le pronostic du jour pour un match à venir, ou met à jour la valeur
 * si ce même match avait déjà été noté lors d'une exécution précédente et n'est
 * pas encore résolu. Un pronostic déjà « réussi »/« échoué »/« indéterminé » n'est
 * jamais modifié — l'historique ne triche pas après coup.
 */
function enregistrerPronostic(predictions, categorieCle, s) {
  const id = `${s.id}-${categorieCle}-${s.date}`;
  const existant = predictions.find((p) => p.id === id);

  if (existant) {
    if (existant.statut === "en_attente") {
      existant.probabilitePredite = s.probabilite;
      existant.dateEnregistrement = new Date().toISOString();
    }
    return;
  }

  predictions.push({
    id,
    equipeId: s.id,
    equipeNom: s.nom,
    competition: s.competition,
    categorie: categorieCle,
    adversaire: s.adversaire,
    domicile: s.domicile,
    dateMatch: s.date,
    probabilitePredite: s.probabilite,
    dateEnregistrement: new Date().toISOString(),
    statut: "en_attente",
  });
}

/**
 * Compare les pronostics en attente dont le match (dans `competitionNom`) est déjà
 * passé avec le résultat réel trouvé dans `historique`, et les marque résolus.
 */
function resoudrePredictions(predictions, competitionNom, historique) {
  const maintenant = Date.now();

  for (const p of predictions) {
    if (p.statut !== "en_attente" || p.competition !== competitionNom) continue;
    if (new Date(p.dateMatch).getTime() > maintenant) continue; // pas encore joué

    const equipe = historique.get(p.equipeId);
    const matchJoue = equipe?.rencontres.find((r) => r.date === p.dateMatch);

    if (matchJoue) {
      const reussi =
        p.categorie === "invaincues" ? matchJoue.issue !== "D" :
        p.categorie === "quiMarquent" ? matchJoue.butsPour >= 2 :
        p.categorie === "btts" ? (matchJoue.butsPour >= 1 && matchJoue.butsContre >= 1) :
        matchJoue.butsPour >= 1; // marqueToujours

      p.statut = reussi ? "reussi" : "echoue";
      p.resultatReel = { score: matchJoue.score, issue: matchJoue.issue };
      p.dateResolution = new Date().toISOString();
    } else if (maintenant - new Date(p.dateMatch).getTime() > JOURS_AVANT_INDETERMINE * 86_400_000) {
      p.statut = "indetermine"; // probablement reporté ou annulé : on arrête d'attendre
    }
  }
}

/** Taux de réussite global et par catégorie, à partir des pronostics résolus. */
function calculerFiabilite(predictions) {
  const resolu = (p) => p.statut === "reussi" || p.statut === "echoue";

  const statsPour = (liste) => {
    const resolues = liste.filter(resolu);
    const reussies = resolues.filter((p) => p.statut === "reussi").length;
    return {
      total: resolues.length,
      reussies,
      echouees: resolues.length - reussies,
      tauxReussite: resolues.length ? Math.round((reussies / resolues.length) * 1000) / 10 : null,
    };
  };

  const parCategorie = Object.fromEntries(
    CATEGORIES_STRATEGE.map((cle) => [cle, statsPour(predictions.filter((p) => p.categorie === cle))])
  );

  return { global: statsPour(predictions), parCategorie };
}

/** Tranches de probabilité utilisées pour la calibration (bornes incluses). */
const TRANCHES_PROBABILITE = [
  [50, 59], [60, 69], [70, 79], [80, 89], [90, 94], [95, 100],
];

/** En dessous de cet effectif, une tranche n'est jamais qualifiée de « haute fiabilité ». */
const EFFECTIF_MIN_HAUTE_FIABILITE = 15;
/** Écart (en points) au-delà duquel on signale une sur/sous-estimation. */
const ECART_CALIBRATION_SIGNALE = 5;

/**
 * Regroupe les pronostics résolus par tranche de probabilité annoncée, et compare pour
 * chaque tranche la probabilité moyenne annoncée au taux de réussite réellement observé.
 * N'affirme jamais qu'une tranche est fiable sans un échantillon suffisant.
 */
function calculerCalibration(predictions) {
  const resolues = predictions.filter((p) => p.statut === "reussi" || p.statut === "echoue");

  const tranches = TRANCHES_PROBABILITE.map(([min, max]) => {
    const dans = resolues.filter((p) => p.probabilitePredite >= min && p.probabilitePredite <= max);
    const reussies = dans.filter((p) => p.statut === "reussi").length;
    const tauxReel = dans.length ? (reussies / dans.length) * 100 : null;
    const probaMoyenneAnnoncee = dans.length
      ? dans.reduce((t, p) => t + p.probabilitePredite, 0) / dans.length
      : null;
    const ecart = tauxReel !== null ? Math.round((tauxReel - probaMoyenneAnnoncee) * 10) / 10 : null;

    let diagnostic = null;
    if (ecart !== null && dans.length >= 5) {
      if (ecart <= -ECART_CALIBRATION_SIGNALE) diagnostic = "Probabilité potentiellement surestimée";
      else if (ecart >= ECART_CALIBRATION_SIGNALE) diagnostic = "Probabilité potentiellement sous-estimée";
    }

    return {
      tranche: `${min}–${max} %`,
      min, max,
      total: dans.length,
      validees: reussies,
      nonValidees: dans.length - reussies,
      tauxReussiteReel: tauxReel !== null ? Math.round(tauxReel * 10) / 10 : null,
      probabiliteMoyenneAnnoncee: probaMoyenneAnnoncee !== null ? Math.round(probaMoyenneAnnoncee * 10) / 10 : null,
      ecart,
      diagnostic,
      echantillonSuffisant: dans.length >= EFFECTIF_MIN_HAUTE_FIABILITE,
    };
  });

  // Seuil de haute fiabilité : parmi les tranches à l'échantillon suffisant, celle avec
  // le meilleur taux réel. Aucun seuil n'est imposé à l'avance — uniquement déduit des données.
  const candidates = tranches.filter((t) => t.echantillonSuffisant && t.tauxReussiteReel !== null);
  const seuilHauteFiabilite = candidates.length
    ? candidates.reduce((meilleure, t) => (t.tauxReussiteReel > meilleure.tauxReussiteReel ? t : meilleure))
    : null;

  return { tranches, seuilHauteFiabilite };
}

/** Statistiques de réussite sur une fenêtre de N derniers jours (ou null pour l'historique complet). */
function statsSurPeriode(predictions, jours) {
  const resolues = predictions.filter((p) => p.statut === "reussi" || p.statut === "echoue");
  const limite = jours === null ? null : Date.now() - jours * 86_400_000;
  const dans = limite === null ? resolues : resolues.filter((p) => new Date(p.dateResolution).getTime() >= limite);
  const reussies = dans.filter((p) => p.statut === "reussi").length;

  return {
    total: dans.length,
    reussies,
    echouees: dans.length - reussies,
    tauxReussite: dans.length ? Math.round((reussies / dans.length) * 1000) / 10 : null,
  };
}

/** Pronostics résolus dont dateResolution tombe le jour calendaire d'aujourd'hui / d'hier. */
function statsJourCalendaire(predictions, decalageJours) {
  const cible = new Date(Date.now() - decalageJours * 86_400_000).toDateString();
  const resolues = predictions.filter(
    (p) => (p.statut === "reussi" || p.statut === "echoue") && new Date(p.dateResolution).toDateString() === cible
  );
  const reussies = resolues.filter((p) => p.statut === "reussi").length;
  return {
    total: resolues.length,
    reussies,
    echouees: resolues.length - reussies,
    tauxReussite: resolues.length ? Math.round((reussies / resolues.length) * 1000) / 10 : null,
  };
}

/** Tableau de performance complet : par période, avec en attente / non évaluables comptés à part. */
function calculerPerformance(predictions) {
  const enAttente = predictions.filter((p) => p.statut === "en_attente").length;
  const nonEvaluables = predictions.filter((p) => p.statut === "indetermine").length;

  return {
    total: predictions.length,
    enAttente,
    nonEvaluables,
    aujourdhui: statsJourCalendaire(predictions, 0),
    hier: statsJourCalendaire(predictions, 1),
    sept_jours: statsSurPeriode(predictions, 7),
    trente_jours: statsSurPeriode(predictions, 30),
    historique_complet: statsSurPeriode(predictions, null),
  };
}

async function main() {
  const resultats = Object.fromEntries(CATEGORIES.map((c) => [c.cle, []]));
  const rencontresAVenir = [];
  const stratege = Object.fromEntries(CATEGORIES_STRATEGE.map((c) => [c, []]));
  const predictions = await chargerHistoriquePredictions();
  const echecs = [];

  for (const competition of COMPETITIONS) {
    try {
      console.log(`Lecture de ${competition.nom}…`);
      const matchs = await matchsTermines(competition.code);
      await pause(6_500); // reste sous les 10 requêtes/minute
      const fixtures = await matchsAVenir(competition.code);

      const historique = historiqueParEquipe(matchs);
      const compteurs = Object.fromEntries(CATEGORIES.map((c) => [c.cle, 0]));
      const entreesParCategorieCeChampionnat = Object.fromEntries(CATEGORIES.map((c) => [c.cle, []]));

      for (const equipe of historique.values()) {
        // Les 3 prochains matchs de cette équipe DANS CE MÊME championnat (pas de coupe,
        // pas de Ligue des champions), utiles pour l'affichage du détail de l'équipe.
        const prochainsMatchs = fixtures
          .filter((m) => m.homeTeam?.id === equipe.id || m.awayTeam?.id === equipe.id)
          .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
          .slice(0, 3)
          .map((m) => ({
            date: m.utcDate,
            competition: competition.nom,
            domicile: m.homeTeam?.shortName || m.homeTeam?.name || "—",
            exterieur: m.awayTeam?.shortName || m.awayTeam?.name || "—",
          }));

        for (const categorie of CATEGORIES) {
          // On regarde au maximum `fenetre` matchs (le plafond), mais si l'équipe
          // n'en a pas encore joué autant cette saison, on travaille avec ce qu'elle
          // a réellement joué — à condition d'avoir au moins SERIE_MIN matchs, sinon
          // une série n'a pas de sens.
          const recents = equipe.rencontres.slice(-categorie.fenetre);
          if (recents.length < SERIE_MIN) continue; // vraiment trop peu de matchs joués

          const serie = longueurSerie(recents, categorie.condition);
          if (serie < SERIE_MIN) continue;

          const entree = {
            id: equipe.id,
            nom: equipe.nom,
            blason: equipe.blason,
            competition: competition.nom,
            pays: competition.pays,
            dernierMatch: recents.at(-1).date,
            detail: recents,
            serie,
            prochainsMatchs,
          };

          resultats[categorie.cle].push(entree);
          entreesParCategorieCeChampionnat[categorie.cle].push(entree);
          compteurs[categorie.cle]++;
        }
      }

      // Rencontres à venir de ce championnat, pour l'onglet « Rencontres ».
      for (const m of fixtures) {
        if (!m.homeTeam || !m.awayTeam) continue;
        rencontresAVenir.push({
          date: m.utcDate,
          championnat: competition.nom,
          domicile: { id: m.homeTeam.id, nom: m.homeTeam.shortName || m.homeTeam.name, blason: m.homeTeam.crest ?? null },
          exterieur: { id: m.awayTeam.id, nom: m.awayTeam.shortName || m.awayTeam.name, blason: m.awayTeam.crest ?? null },
        });
      }

      // Résout les pronostics de ce championnat dont le match est déjà passé,
      // en comparant à l'historique qu'on vient de recalculer.
      resoudrePredictions(predictions, competition.nom, historique);

      // Module Stratège : uniquement pour les équipes des 3 catégories concernées,
      // en cherchant leur prochain match DANS CE MÊME championnat.
      for (const categorieCle of CATEGORIES_STRATEGE) {
        const fenetreCategorie = CATEGORIES.find((c) => c.cle === categorieCle).fenetre;
        for (const entree of entreesParCategorieCeChampionnat[categorieCle]) {
          const s = calculerStratege(categorieCle, entree, historique, fixtures, fenetreCategorie);
          stratege[categorieCle].push(s);
          if (s.statut === "ok") enregistrerPronostic(predictions, categorieCle, s);
        }
      }

      const resume = CATEGORIES.map((c) => `${c.cle}: ${compteurs[c.cle]}`).join(", ");
      console.log(`  ${matchs.length} matchs terminés, ${fixtures.length} à venir — ${resume}`);
    } catch (erreur) {
      console.error(`  Échec sur ${competition.nom} : ${erreur.message}`);
      echecs.push(competition.nom);
    }
    await pause(6_500); // reste sous les 10 requêtes/minute
  }

  rencontresAVenir.sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const categorieCle of CATEGORIES_STRATEGE) {
    stratege[categorieCle].sort((a, b) => {
      if (a.statut !== "ok" && b.statut !== "ok") return 0;
      if (a.statut !== "ok") return 1;
      if (b.statut !== "ok") return -1;
      return b.probabilite - a.probabilite;
    });
  }

  const sortie = {
    genereLe: new Date().toISOString(),
    serieMin: SERIE_MIN,
    fenetres: Object.fromEntries(CATEGORIES.map((c) => [c.cle, c.fenetre])),
    joursAVenir: JOURS_A_VENIR,
    competitionsAnalysees: COMPETITIONS.filter((c) => !echecs.includes(c.nom)).map((c) => c.nom),
    competitionsEnEchec: echecs,
    rencontresAVenir,
    stratege,
    fiabilite: calculerFiabilite(predictions),
    calibration: calculerCalibration(predictions),
    performance: calculerPerformance(predictions),
    // Historique complet pour les filtres (type / championnat / période / statut) côté site.
    // Plafonné pour ne pas faire grossir le fichier indéfiniment ; les plus anciens sortent en premier.
    historiquePredictions: predictions
      .slice()
      .sort((a, b) => new Date(b.dateEnregistrement) - new Date(a.dateEnregistrement))
      .slice(0, 1000),
  };
  for (const categorie of CATEGORIES) {
    sortie[categorie.cle] = trierParSerie(resultats[categorie.cle]);
  }

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(sortie, null, 2), "utf8");
  await writeFile(HISTORIQUE_PREDICTIONS, JSON.stringify({ predictions }, null, 2), "utf8");

  const bilan = CATEGORIES.map((c) => `${sortie[c.cle].length} ${c.cle}`).join(", ");
  const f = sortie.fiabilite.global;
  console.log(
    `\nTerminé : ${bilan}, ${rencontresAVenir.length} rencontres à venir → data/invaincus.json\n` +
    `Fiabilité : ${f.reussies}/${f.total} pronostics résolus réussis` +
    (f.tauxReussite !== null ? ` (${f.tauxReussite} %)` : "") +
    ` → data/historique-predictions.json`
  );
}

main().catch((erreur) => {
  console.error(erreur);
  process.exit(1);
});
