/**
 * Note the localization beyond words: bytes are "octets" (symbol "o", not "B").
 * Number grouping (1 024 vs 1,024) is handled by `n()` via Intl, not here.
 */
import type { Messages } from "../en/onchainPreview";

const onchainPreview: Messages = {
  titlePublic: "Aperçu on-chain",
  titleSealed: "Texte en clair à sceller",
  encBadge: "chiffré à l'envoi",
  bytes: "{size} o",
  feeApprox: "≈ {ada} ₳",
  encoding: "Encodage…",
  emptyForm:
    "Complétez le formulaire pour prévisualiser la charge utile du label 17.",
  formatLabel: "Format d'aperçu",
  formatDiagnostic: "Diagnostic",
  formatHex: "Hex",
  copy: "Copier",
  copied: "Copié ✓",
  notePublic:
    "Frais minimum estimés pour une transaction simple — le coût réel dépend de la sélection des UTxO et des témoins. La charge utile fait {size} sur {max} octets de transaction maximum.",
  noteSealed:
    "Ce sont les réponses telles qu'elles seront chiffrées par verrou temporel au moment de l'envoi — rien n'est encore chiffré. La charge utile on-chain sera le chiffré obtenu, complété par des zéros{padding} afin que sa taille ne révèle jamais l'étendue de vos réponses. Les frais sont calculés au moment de l'envoi.",
  noteSealedPadding: " jusqu'à {size} o",
};

export default onchainPreview;
