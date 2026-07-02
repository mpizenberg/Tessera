/**
 * Localization notes: provider/product names (Pinata, Blockfrost, NMKR, Koios,
 * IPFS, Cardano) and network identifiers (Preview, Mainnet) stay untranslated.
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
    "La lecture et la construction des transactions passent par le backend Tessera par défaut : aucun jeton Koios n'est nécessaire (les transactions sont tout de même signées par votre portefeuille). Un jeton n'est utile que pour la voie Koios directe, employée en l'absence de backend — il sert alors à lire les données de la chaîne et à construire les transactions. Stocké uniquement dans ce navigateur ; appliqué à l'enregistrement. Changer de réseau recharge l'application sur Explorer pour appliquer le nouveau point d'accès.",
  networkLabel: "Réseau",
  dataSourceLabel: "Source de données",
  dataSourceDirect: "Koios direct",
  endpointLabel: "Point d'accès Koios",
  activeTokenLabel: "Jeton Koios",
  tokenYours: "défini",
  tokenNone: "aucun",
  koiosTokenLabel: "Votre jeton Koios",
  koiosTokenPlaceholder: "collez un jeton bearer Koios",
  koiosTokenAria: "Jeton bearer Koios",
  save: "Enregistrer",
  clearToken: "Effacer",
  savedMsg: "✓ enregistré · instantané rechargé",

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
