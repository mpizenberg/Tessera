/**
 * French Explore catalog. Localization beyond words: time-left uses French
 * abbreviations (j/h/min), "octets"/"o" for bytes elsewhere. Number grouping is
 * handled by `n()` via Intl, not here. Cardano governance terms (DRep, SPO, CC,
 * Info Action) are kept as the on-chain identifiers used in the ecosystem.
 */
import type { Messages } from "../en/explore";

const explore: Messages = {
  filterAll: "Tous",
  filterLinked: "Gouvernance",
  filterActive: "Actifs",
  filterSealed: "Scellés",
  filterPublic: "Publics",
  filterMine: "Les miens",

  endingNow: "se termine maintenant",
  timeLeftDaysHours: "{d}j {h}h restantes",
  timeLeftHoursMinutes: "{h}h {m}min restantes",
  timeLeftMinutes: "{m}min restantes",
  endsWithdrawn: "retiré",
  endsClosed: "terminé",

  pageTitle: "Sondages & scrutins",
  summary: "{count} entrées · époque actuelle {epoch}",
  newSurvey: "Nouveau sondage",

  searchPlaceholder: "Rechercher des sondages…",

  headerForm: "Formulaire",
  headerAnsweredTitle: "Sondages auxquels vous avez répondu",
  headerSurvey: "Sondage",
  headerEligible: "Éligibles",
  headerEnds: "Fin",
  headerReplies: "Réponses",

  loadError: "Échec du chargement : {error}",
  incomplete:
    "Affichage des sondages et réponses les plus récents — il en existe davantage on-chain que ce qui a pu être chargé, donc certaines listes et certains décomptes peuvent être incomplets.",

  sectionGov: "Gouvernance on-chain",
  sectionGovNote: "Liés à une Info Action — affichés en premier.",
  sectionOpen: "Ouverts · réponses acceptées",
  sectionClosed: "Terminés",
  sectionClosedNote: "Terminés ou retirés — lecture seule.",

  noMatch: "Aucun sondage correspondant.",

  answeredTitle: "Vous avez répondu à ce sondage",
  answeredAria: "répondu",
  badgeYours: "À vous",
  badgeOffChain: "⚠ libellés off-chain",
  govInfoAction: "Info Action {id}",
  govInfoActionTitle: " · {title}",
  untitled: "Sans titre · contenu externe",
  noPresentation:
    "Texte de présentation indisponible — structure on-chain intacte.",
  refTitle:
    "Réf complète du sondage — hash de la transaction de définition et indice de sortie",
  refEpoch: "époque {epoch}",
  refLabel: "réf {ref}",

  metaForm: "Formulaire",
  metaEligible: "Éligibles",
  metaEnds: "Fin",
  metaReplies: "Réponses",
  metaEpoch: "Époque",

  legendForm: "Formulaire — une tuile par question.",
  legendPublic: "public",
  legendSealed: "scellé jusqu'à la révélation",
  legendAnswered: "vous avez répondu",

  introDismiss: "Fermer",
  introTitle: "Sondages & scrutins on-chain sur Cardano",
  introBody:
    "Tessera enregistre les sondages directement dans les métadonnées des transactions Cardano — sans backend, sans compte. Parcourez tout ci-dessous gratuitement ; connectez un portefeuille pour répondre selon votre rôle on-chain (DRep, SPO, CC ou détenteur d'enjeu) ou pour publier le vôtre. Les réponses peuvent être publiques ou scellées — chiffrées par verrou temporel pour une révélation différée.",
};

export default explore;
