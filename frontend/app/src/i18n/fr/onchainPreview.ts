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
    "L'aperçu ci-dessous montre vos réponses en clair — rien n'est encore chiffré. À l'envoi, elles sont chiffrées par verrou temporel en un chiffré de taille fixe, complété par des zéros{padding} afin que sa taille ne révèle jamais l'étendue de vos réponses. La taille et les frais ci-dessus concernent cette charge utile chiffrée on-chain : {size} sur {max} octets de transaction maximum.",
  noteSealedPadding: " jusqu'à {size} o",
};

export default onchainPreview;
