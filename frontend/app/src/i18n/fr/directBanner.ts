import type { Messages } from "../en/directBanner";

const directBanner: Messages = {
  emergencyStrong: "Mode direct d'urgence.",
  emergencyRest:
    "Ce navigateur lit la chaîne via Koios, sans le backend Tessera. Les réponses sont non vérifiées — les preuves d'identifiant et les poids de vote ne sont contrôlés qu'à la finalisation. Le backend reprend {time}.",
  strong: "Mode Koios direct.",
  rest: "Les réponses sont non vérifiées — les preuves d'identifiant et les poids de vote ne sont contrôlés qu'à la finalisation. Utilisez le vérificateur indépendant pour auditer les résultats.",
};

export default directBanner;
