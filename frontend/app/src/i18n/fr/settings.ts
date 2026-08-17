/**
 * Localization notes: provider/product names (Pinata, Blockfrost, NMKR, Koios,
 * IPFS, Cardano) and network identifiers stay untranslated.
 * Prose paragraphs are split around their inline-bold fragments so the bold
 * stays real <b> markup in JSX, matching the English structure.
 */
import type { Messages } from "../en/settings";

const settings: Messages = {
  // Page header
  title: "Paramètres",
  lead: "Stockés uniquement dans ce navigateur. Rien de tout cela ne touche la charge utile on-chain — les sondages sont toujours validés et dépouillés à partir des seules données de la chaîne.",

  // --- Off-chain content storage (IPFS providers) section ---
  storageSectionHead: "Stockage de contenu hors chaîne",
  storageHeading: "Services d'épinglage IPFS",
  storageProse1: "Nécessaires uniquement pour ",
  storageProseAuthor: "créer",
  storageProse2:
    " du contenu que l'application stocke hors chaîne — le document de présentation d'un sondage externe, ou la justification d'un votant. Activez-en un ou plusieurs ; chaque document est épinglé sur ",
  storageProseEvery: "chaque",
  storageProse3:
    " service activé en parallèle pour une meilleure disponibilité (même empreinte de contenu partout). Les sondages intégrés et la lecture n'en ont jamais besoin.",
  enabledCount: "{count} activé(s)",
  providerSet: "Défini",
  providerNotSet: "Non défini",
  providerTokenLabel: "Jeton d'API {provider}",
  storageNote1:
    "L'épinglage maintient un document accessible ; s'il venait à disparaître, les sondages restent validés et dépouillés à partir des données on-chain — seuls les libellés de présentation ne peuvent plus être affichés. L'empreinte d'ancrage est calculée localement (",
  storageNoteBlake: "blake2b-256",
  storageNote2:
    ") à partir des octets exacts envoyés, de sorte qu'un fournisseur ne peut pas altérer ce que vous ancrez. Les jetons restent uniquement dans ce navigateur.",

  // --- Network & data source (Koios) section ---
  koiosSectionHead: "Réseau et source de données",
  koiosHeading: "Réseau et jeton Koios",
  koiosProse:
    "La lecture et la construction des transactions passent par le backend Tessera par défaut : aucun jeton Koios n'est nécessaire (les transactions sont tout de même signées par votre portefeuille). Un jeton n'est utile que pour la voie Koios directe — le mode direct d'urgence ci-dessous, ou une version sans backend configuré — où il sert à lire les données de la chaîne et à construire les transactions. Stocké uniquement dans ce navigateur ; appliqué à l'enregistrement. Chaque déploiement dessert un seul réseau.",
  networkLabel: "Réseau",
  networkLink: "ouvrir l'application {network} ↗",
  dataSourceLabel: "Source de données",
  dataSourceDirect: "Koios direct",
  endpointLabel: "Point d'accès Koios",
  activeTokenLabel: "Jeton Koios",
  buildLabel: "Version de l'app",
  tokenYours: "défini",
  tokenNone: "aucun",
  koiosTokenLabel: "Votre jeton Koios",
  koiosTokenPlaceholder: "collez un jeton bearer Koios",
  koiosTokenAria: "Jeton bearer Koios",
  save: "Enregistrer",
  clearToken: "Effacer",
  savedMsg: "✓ enregistré · instantané rechargé",
  indexerUrlLabel: "Votre URL de backend",
  indexerUrlPlaceholder: "https://… (vide = Koios direct)",
  indexerUrlAria: "URL du backend Tessera",
  indexerUrlHint:
    "Remplace le backend intégré pour ce réseau, uniquement dans ce navigateur. Il doit desservir le même réseau — l'application vérifie et refuse un backend discordant. Enregistrer ou effacer recharge l'application.",
  directModeLabel: "Mode direct d'urgence",
  directModeProse:
    "Si le backend est indisponible, ce navigateur peut continuer à participer en lisant la chaîne et en construisant les transactions directement via Koios, avec votre jeton. Les réponses affichées ainsi sont non vérifiées — les preuves d'identifiant et les poids de vote ne sont contrôlés qu'à la finalisation — et les résultats finalisés sont indisponibles. Le mode expire de lui-même après 24 heures ; votre jeton reste enregistré dans tous les cas.",
  directModeActivate: "Lire via Koios pendant 24 h",
  directModeActive: "Actif — retour au backend {time}",
  directModeDeactivate: "Revenir au backend maintenant",
  directModeNeedsToken:
    "Enregistrez d'abord un jeton Koios ci-dessus — la lecture directe est impossible sans jeton.",

  // --- Display preferences section ---
  displaySectionHead: "Affichage",
  detailHeading: "Niveau de détail",
  detailProsePro: "Pro",
  detailProse1:
    " fait apparaître les détails techniques dans toute l'application — références de sondage, époques, tours drand, tailles de remplissage et champs de création supplémentaires. ",
  detailProsePlain: "Simple",
  detailProse2: " les masque. Aussi activable depuis l'en-tête.",
  displayModeAria: "Mode d'affichage",
  displayPlain: "Simple",
  displayPro: "Pro",

  // --- Language (already migrated) ---
  languageHeading: "Langue",
  languageProse:
    "Choisissez la langue de l'interface. Les nombres et les unités suivent aussi votre choix.",
};

export default settings;
