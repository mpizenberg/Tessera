/**
 * French survey catalog. Units localized (bytes → octets where relevant);
 * number grouping is handled by `n()` via Intl. Placeholders match English.
 */
import type { Messages } from "../en/survey";

const survey: Messages = {
  // Top navigation
  backAll: "Tous les sondages",

  // Question type labels (BASE_TYPE)
  typeCustom: "Personnalisé",
  typeSingleChoice: "Choix unique",
  typeMultiSelect: "Choix multiple",
  typeRanking: "Classement",
  typeNumericRange: "Plage numérique",
  typePointsAllocation: "Points",
  typeRating: "Notation",

  // Status pills
  pillOpen: "Ouvert",
  pillSealed: "Scellé",
  pillRevealed: "Révélé",
  pillClosed: "Clôturé",
  pillWithdrawn: "Retiré",

  // Unverified cancellation notice
  claimedNoticeStrong: "Annulation revendiquée non vérifiée.",
  claimedNoticeRest:
    "Une annulation référençant ce sondage a été publiée, mais ce client n'a pas pu vérifier qu'elle provenait du propriétaire du sondage — elle est donc ignorée et le sondage reste ouvert. Seule une annulation signée par le propriétaire clôt un sondage.",

  // Respond CTA
  respondCta: "Répondre à ce sondage",

  // Owner controls (cancel)
  cancelSubmittedTitle: "Annulation envoyée",
  cancelSubmittedBody:
    "Les nouvelles réponses seront rejetées une fois l'annulation indexée. La définition reste on-chain à titre de référence.",
  ownerText:
    "Vous pouvez le retirer — les réponses existantes restent on-chain mais les nouvelles sont rejetées.",
  ownerTextStrong: "Vous êtes le propriétaire de ce sondage.",
  cancelSurvey: "Annuler le sondage",
  cancelling: "Annulation…",
  confirmCancel: "Confirmer l'annulation",
  keep: "Conserver",

  // Link survey to a governance Info Action
  linkOptional: "Optionnel",
  linkTitle: "Lier ce sondage à une Info Action de gouvernance",
  linkBody1: "Le lien va",
  linkBodyDirection: "Action → Sondage",
  linkBody2:
    " : votre sondage existe déjà, l'Info Action ne fait donc que le désigner. Imbriquez cet objet en tant que",
  linkBody3: "dans le",
  linkBody4: "CIP-108 de l'Info Action (et ajoutez les termes",
  linkBody5:
    "de CIP-179, conformément à la spécification, pour que l'ancre reste un document JSON-LD valide). L'epoch de fin de vote de l'action doit être égale au",
  linkBody6: " de ce sondage, sinon l'outillage ne l'attachera pas.",
  copied: "Copié ✓",
  copyJson: "Copier le JSON",
  linkFootnote:
    "seules les Info Actions peuvent établir un lien · le lien sert à la découverte + à l'alignement d'epoch, jamais de critère d'éligibilité",

  // Header
  govPill: "Lié à la gouvernance",
  refTitle:
    "Référence complète du sondage — hash de la transaction de définition et index de sortie",
  refLead: "ref {ref}",
  untitledSurvey: "Sondage sans titre",
  govLinkBadge: "Info Action",
  govLinkAdvertisedFallback: "Annoncé par une Info Action de gouvernance",
  govLinkAdvertisedBy: "Annoncé par",
  govLinkMeta:
    "le sondage et le vote se clôturent tous deux à l'epoch {epoch} · ouvert à tous les rôles éligibles — voter sur l'action liée est optionnel",
  roleCountPct: "· {pct}%",

  // Per-question result widgets
  qLabel: "Q{n}",
  noPrompt: "(sans intitulé)",
  abstained: "{n} abstention(s)",
  typeSuffixResponders: "% des répondants",
  typeSuffixFirstPreferences: "premières préférences",
  typeSuffixDistribution: "distribution",
  typeSuffixAverageAllocation: "allocation moyenne",
  typeSuffixNumericGrid: "grille numérique",
  typeSuffixLabelledScale: "échelle libellée",
  typeSuffixInterpretedOffchain: "interprété off-chain",
  typeLabelJoined: "{base} · {suffix}",
  pointsMeta: "{avg} pts",

  // Histogram card
  histMean: "moyenne",
  histMedian: "médiane",

  // Custom card
  customCountLabel: "réponses libres · comptabilisées selon le schéma externe",

  // Empty states
  roleFilterAll: "Tous",
  noResponsesYet: "Aucune réponse pour l'instant.",

  // Exclusion meta
  exclAfterDeadlineLabel: "Soumise après la date limite",
  exclAfterDeadlineHint: "enregistrée après end_epoch {epoch}",
  exclInvalidLabel: "Invalide pour ce sondage",
  exclInvalidHint:
    "réponse hors contrainte, rôle inéligible ou réponse requise manquante",
  exclSupersededLabel: "Remplacée par une réponse ultérieure",
  exclSupersededHint: "même rôle + identifiant · la plus récente l'emporte",
  exclUndecryptableLabel: "Impossible à déchiffrer ou à décoder",
  exclUndecryptableHint: "charge utile malformée ou non conforme",

  // Exclusion panel
  exclHeadTitle: "Pourquoi des réponses n'ont pas été comptées",
  exclHeadNote: "vérifications on-chain uniquement",
  exclFootnote1:
    "Les réponses exclues restent on-chain mais ne sont pas comptabilisées. Les vérifications d'éligibilité qui nécessitent l'état du registre — appartenance à un rôle revérifiée au snapshot",
  exclFootnote2:
    "et preuves d'identifiant — sont résolues par un indexeur et ne sont pas reflétées ici.",

  // Individual responses
  individualResponses: "Réponses individuelles",
  showMore: "Afficher {n} de plus ({left} restantes)",

  // Response card
  responseRationaleTitle:
    "Ouvrir le document de justification du votant dans un nouvel onglet (non vérifié par hash)",
  responseRationale: "justification ↗",
  responseSealed: "(scellée — pas encore révélée)",
  responseAnswerQ: "Q{n}",

  // Results body — counted/excluded/export
  counted: "{n} comptée(s)",
  excluded: "{n} exclue(s)",
  exportCsv: "Exporter en CSV",
  incomplete:
    "Il existe on-chain plus de transactions label 17 que ce qui a pu être chargé, ce décompte peut donc omettre des réponses.",

  // Weighting disclaimer
  disclaimerBadge: "brut",
  disclaimerText1:
    "Ce sont des réponses enregistrées brutes — une par identifiant.",
  disclaimerNoWeighting: "Aucune pondération n'est appliquée ;",
  disclaimerText2:
    "la pondération par stake, par pledge ou quadratique est en aval et hors du périmètre de CIP-179.",

  // Role filter
  roleFilterLabel: "Décompte par rôle",

  tallyFootnote:
    "décompte calculé indépendamment à partir des données on-chain · {n} réponses comptées",

  // Sealed results states
  sealedCancelledTitle: "Ce sondage a été annulé",
  sealedCancelledBody:
    "Le propriétaire l'a retiré. Les éventuelles réponses scellées restent on-chain mais ne sont pas comptabilisées.",
  sealedUnsupportedTitle: "Chaîne drand non prise en charge",
  sealedUnsupportedBody:
    "Ce sondage scellé épingle une chaîne drand que Tessera ne peut pas déchiffrer — seule quicknet est prise en charge ici.",
  sealedTitle: "Les réponses sont scellées",
  sealedBody:
    "{n} {responses} chiffrée(s) collectée(s). Elles s'ouvriront {date} — personne, pas même le propriétaire, ne peut les lire avant la publication du round drand.",
  responseSingular: "réponse",
  responsePlural: "réponses",
  revealingTitle: "Révélation…",
  revealingBody:
    "Récupération de la balise drand et déchiffrement des réponses.",
  revealErrorTitle: "Échec de la révélation",
  sealedRevealableTitle: "Les réponses peuvent maintenant être révélées",
  sealedRevealableBody:
    "Le round drand a été publié le {date}. La révélation déchiffre les {n} {responses} scellée(s) dans votre navigateur et les comptabilise.",
  revealAll: "Révéler toutes les réponses",

  // Labels-unavailable notice
  labelsTitle: "Libellés de présentation indisponibles",
  labelsBody1: "Le document off-chain (",
  labelsBody2:
    ") n'a pas pu être récupéré ou a échoué à sa vérification de hash, les titres et les libellés d'options ne peuvent donc pas être affichés.",
  labelsBodyAccurate: "Les résultats restent exacts",
  labelsBody3:
    "— chaque type de question, décompte et contrainte est on-chain, et les réponses référencent les",
  labelsBodyIndices: "indices",
  labelsBody4: " des options, qui sont comptabilisés normalement.",

  // Empty / loading / error
  loading: "Chargement…",
  notFound: "Sondage introuvable.",
  loadError:
    "Échec du chargement depuis le réseau — il peut s'agir d'une erreur transitoire.",
  retry: "Réessayer",
};

export default survey;
