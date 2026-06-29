/**
 * Note the localization beyond words: bytes are "octets" and the gov vocabulary
 * (Info Action, end_epoch, gov_action_deposit/_lifetime) is kept as technical
 * tokens. Number grouping is handled by `n()` via Intl, not here.
 */
import type { Messages } from "../en/proposeInfoAction";

const proposeInfoAction: Messages = {
  // En-tête / introduction
  backToSurveys: "Tous les sondages",
  govPill: "Gouvernance",
  title: "Proposer une Info Action pour un sondage",
  leadPre: "Construisez et signez une ",
  leadMid:
    " Conway annonçant un sondage CIP-179. L'action n'a aucun effet on-chain — elle se contente d'orienter les votants vers le sondage via son ancre. Un ",
  leadPost:
    " remboursable est prélevé sur votre portefeuille et restitué à votre adresse de staking lorsque l'action est ratifiée ou expire (votre portefeuille indique le montant exact avant la signature).",

  // Problèmes de validation (vérification de la forme du JSON)
  problemNotJson: "JSON invalide : {message}",
  problemMissingContext:
    "Champ JSON-LD « @context » manquant (termes CIP-100/108).",

  // Notes d'alignement d'époque
  alignTipNotLoaded:
    "Pointe de chaîne pas encore chargée — impossible de vérifier l'alignement d'époque.",
  alignSurveyNotOnchain:
    "Le sondage lié n'est pas encore on-chain — impossible de vérifier son end_epoch. Assurez-vous qu'il est publié et indexé.",
  alignLifetimeUnknown:
    "gov_action_lifetime est inconnu — impossible de calculer l'échéance du vote.",
  alignAligned:
    "Aligné — soumettre maintenant (époque {epoch}) fixe l'échéance du vote à l'époque {end}, correspondant au end_epoch du sondage.",
  alignTooEarly:
    "Trop tôt — soumettez à l'époque {submitEpoch} (dans {remaining} de plus) pour correspondre au end_epoch {end} du sondage. Soumettre maintenant fixerait l'échéance à {deadline}.",
  alignWindowPassed:
    "Fenêtre dépassée — le sondage se termine à l'époque {end}, donc cette action devait être soumise à l'époque {submitEpoch}. Soumise maintenant (époque {epoch}), elle expirerait à {deadline} et ne peut plus être liée à ce sondage.",

  // Étape 1 · Charger l'ancre
  step1Head: "1 · Charger le document d'ancre",
  loadHintPre: "Choisissez le fichier d'ancre CIP-108 ",
  loadHintMid: " (son ",
  loadHintPost:
    " porte le lien du sondage). Il est lu localement — le hash on-chain est calculé sur les octets exacts du fichier, qui ne sont donc jamais reformatés.",

  // Étape 1b · Document chargé
  loaded: "Chargé",
  problemsTitle: "Lien de sondage CIP-179 invalide :",
  linksToSurvey: "Lien vers le sondage",
  refIndex: " · index {index}",
  onchainPre: "On-chain : ",
  onchainPost: " · end_epoch {endEpoch}",
  untitledSurvey: "Sondage sans titre",
  hostHintPre:
    "Hébergez ces octets exacts à une URL publique (un lien brut GitHub, ou ajoutez un fournisseur IPFS dans ",
  hostHintPost: " pour épingler depuis ici), puis collez l'URL à l'étape 2.",
  settingsLinkText: "Paramètres",
  pinHint:
    "Épinglez aux fournisseurs IPFS configurés dans vos Paramètres, en un clic. Les octets exacts ci-dessous sont épinglés, donc le document servi correspond au hash on-chain.",
  pinning: "Épinglage…",
  pinToIpfs: "Épingler sur IPFS",
  downloadJsonld: "Télécharger le .jsonld",
  copiedHash: "Hash copié ✓",
  copyAnchorHash: "Copier le hash de l'ancre",
  pinnedNote: "Épinglé sur {providers}. URL renseignée ci-dessous.",
  anchorHashLabel: "Hash de l'ancre (blake2b-256)",

  // Étape 2 · URL de l'ancre
  step2Head: "2 · URL de l'ancre",
  urlPlaceholder: "ipfs://… ou https://…/info-action-survey-link.jsonld",
  urlHint:
    "Renseignée automatiquement lorsque vous épinglez sur IPFS ci-dessus ; sinon, collez l'endroit où vous avez hébergé le document. Stockée on-chain avec son hash.",
  urlInvalidPre: "L'URL de l'ancre doit être une adresse ",
  urlInvalidMid: " ou ",
  urlInvalidPost: " — celle-ci sera rejetée avant la signature.",

  // Étape 3 · Signer & soumettre
  step3Head: "3 · Signer & soumettre",
  connectWallet:
    "Connectez un portefeuille CIP-30 (en haut à droite) pour signer la proposition.",
  networkMismatch:
    "Votre portefeuille est sur un réseau différent de celui de l'application ({network}). Changez-le avant de soumettre.",
  resolveIssues:
    "Corrigez les problèmes de validation à l'étape 1 avant de soumettre — l'action ne serait pas un lien de sondage CIP-179 valide.",
  building: "Construction & signature…",
  submit: "Construire, signer & soumettre",
  submittedTitle: "Proposition soumise ✓",
  submittedHint:
    "Une fois dans un bloc, la page du sondage l'affichera comme « Lié à la gouvernance » après que l'indexeur a résolu l'ancre.",
};

export default proposeInfoAction;
