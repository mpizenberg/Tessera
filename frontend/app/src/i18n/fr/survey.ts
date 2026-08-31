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

  // Unverified cancellation notice
  claimedNoticeStrong: "Annulation revendiquée non vérifiée.",
  claimedNoticeRest:
    "Une annulation référençant ce sondage a été publiée, mais ce client n'a pas pu vérifier qu'elle provenait du propriétaire du sondage — elle n'est donc pas prise en compte. Seule une annulation signée par le propriétaire invalide un sondage.",

  // Avis de définition invalide (sondage non décomptable)
  invalidNoticeStrong: "Définition invalide.",
  invalidNoticeRest:
    "La définition on-chain de ce sondage n'est pas conforme à CIP-179 v5 (mauvaise version de spec, ou une contrainte interdite par la spec) : elle est donc non décomptable : aucun résultat n'est produit et répondre est désactivé. La définition reste on-chain à titre de référence.",

  // Avis « pas encore sur la chaîne » (sondage optimiste bloqué)
  notOnChainNoticeStrong: "Pas encore sur la chaîne.",
  notOnChainNoticeRest:
    "La transaction publiant ce sondage n'a pas été observée dans un bloc depuis un moment — elle n'a peut-être pas été acceptée par le réseau. Le sondage n'est visible que dans cette session ; s'il n'atterrit jamais, publiez-le à nouveau.",

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
  switchNetwork: "Basculez votre portefeuille sur {network} pour annuler",

  // Lier le sondage à une action de gouvernance (entrée vers /survey/:key/link)
  linkTitle: "Lier ce sondage à une action de gouvernance",
  linkHint:
    "Annoncez-le depuis une action de gouvernance Conway : Tessera produit le document d'ancre CIP-108 lié, et peut construire et soumettre une Info Action qui le porte.",
  linkCta: "Ouvrir l'outil de liaison",
  linkWindowClosed:
    "La fenêtre de liaison est fermée — une action de gouvernance correspondante devait être proposée pendant l'époque {submitEpoch}, et une action proposée maintenant survivrait au sondage.",

  // Header
  refTitle:
    "Référence complète du sondage — hash de la transaction de définition et index de sortie",
  refLead: "ref {ref}",
  untitledSurvey: "Sondage sans titre",
  govLinkBadge: "Action liée",
  govLinkAdvertisedFallback: "Annoncé par une action de gouvernance",
  govLinkAdvertisedBy: "Annoncé par",
  govLinkMeta:
    "le sondage et le vote se clôturent tous deux à l'epoch {epoch} · ouvert à tous les rôles éligibles — voter sur l'action liée est optionnel",
  // Carte de résumé du sondage (en-tête) : métadonnées + décompte par rôle
  // (sans pourcentages inter-rôles — électorats distincts, non comparables).
  summaryQuestions: "Questions",
  summaryEligible: "Éligibles",
  summaryEnds: "Clôture",
  summaryResponses: "Réponses",

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

  // Détail supplémentaire — recalculé localement, hors empreinte du décompte
  derived: "calculé localement",
  derivedTitle:
    "Relu depuis les réponses comptabilisées, dans votre navigateur. Contrairement aux chiffres ci-dessus, cela ne fait pas partie de ce que l'empreinte de l'artefact de décompte engage.",

  // Empty states
  noResponsesYet: "Aucune réponse pour l'instant.",

  // Exclusion meta
  exclAfterDeadlineLabel: "Soumise après la date limite",
  exclAfterDeadlineHint: "enregistrée après end_epoch {epoch}",
  exclInvalidLabel: "Invalide pour ce sondage",
  exclInvalidHint:
    "réponse hors contrainte, rôle inéligible ou réponse requise manquante",
  exclUnprovenLabel: "Preuve d'identifiant en échec",
  exclUnprovenHint:
    "la transaction de réponse ne prouve pas l'identifiant du rôle revendiqué",
  exclSupersededLabel: "Remplacée par une réponse ultérieure",
  exclSupersededHint: "même rôle + identifiant · la plus récente l'emporte",
  exclUndecryptableLabel: "Impossible à déchiffrer ou à décoder",
  exclUndecryptableHint: "charge utile malformée ou non conforme",

  // Exclusion panel
  exclHeadTitle: "Pourquoi des réponses n'ont pas été comptées",
  exclHeadNote: "vérifications on-chain uniquement",
  exclHeadNoteProofs:
    "vérifications on-chain + verdicts de preuve de l'indexeur",
  exclFootnote1:
    "Les réponses exclues restent on-chain mais ne sont pas comptabilisées. Les vérifications d'éligibilité qui nécessitent l'état du registre — appartenance à un rôle revérifiée au snapshot",
  exclFootnote2:
    "et preuves d'identifiant — sont résolues par un indexeur et ne sont pas reflétées ici.",
  exclFootnoteProofs1:
    "Les réponses exclues restent on-chain mais ne sont pas comptabilisées. Les preuves d'identifiant affichées ici sont les verdicts de l'indexeur ; l'appartenance à un rôle et les poids de vote revérifiés au snapshot",
  exclFootnoteProofs2:
    "sont résolus à la finalisation et ne sont pas reflétés ici.",

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
  pendingProofs: "{n} en attente de vérification de preuve",
  excluded: "{n} exclue(s)",
  exportCsv: "Exporter en CSV",
  incomplete:
    "Il existe on-chain plus de transactions label 17 que ce qui a pu être chargé, ce décompte peut donc omettre des réponses.",

  // Note informative (affichée sur chaque vue de résultats). Les décomptes de
  // Tessera sont indicatifs ; le créateur du sondage interprète le résultat.
  infoBadge: "info",
  infoNoteStrong: "Décompte informatif.",
  infoNote:
    "Tessera comptabilise les réponses on-chain selon les règles génériques de CIP-179. Il ne peut pas appliquer les règles de validité propres à un sondage, ses listes d'autorisation ou une pondération personnalisée (quadratique, plafonds, …) — l'interprétation du résultat revient au créateur du sondage.",

  // Résultats finaux (vue artefact) : sélecteur de pondération + exports
  weightingLabel: "Pondération",
  weightingChain: "Pondéré par la chaîne",
  weightingOne: "Une voix chacun",
  exportArtifact: "Exporter l'artefact",
  exportVotesCsv: "Exporter les votes (CSV)",
  weightedShowRaw: "Voir les réponses brutes",
  weightedShowFinal: "← Résultats finaux",
  weightedCounted: "{n} comptées",
  weightedVotingWeight: "{ada} ₳ de poids de vote",
  weightedTurnout: "{pct} % de participation",
  weightedBarMeta: "{ada} ₳ · {n}",
  weightedCancelledTitle: "Sondage annulé par son propriétaire",
  weightedCancelledBody:
    "Une annulation prouvée par le propriétaire a été enregistrée sur la chaîne à l'époque {epoch} ; aucun résultat n'est décompté.",
  weightedFootnote:
    "appartenance & pondérations figées à l'époque de clôture {epoch} depuis {provider} · re-vérifiable indépendamment · artefact {hash}",

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
