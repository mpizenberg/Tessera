import type { Messages } from "../en/healthFooter";

const healthFooter: Messages = {
  updated: "données datant de {age}",
  updatedStale: "données datant de {age} — rafraîchissement peut-être bloqué",
  updatedTitle: "Âge de l'instantané on-chain servi",
  koiosRefresh: "Koios {calls}/{limit}",
  koiosRefreshTitle:
    "Requêtes du dernier rafraîchissement — lectures Koios et récupérations d'ancres de gouvernance — rapportées au budget par rafraîchissement",
  koiosDaily: "{calls} appels / 24 h",
  koiosDailyWithLimit: "{calls}/{limit} appels / 24 h",
  koiosDailyTitle:
    "Requêtes sur l'ensemble des rafraîchissements des dernières 24 heures",
  lastFailed: "dernier rafraîchissement en échec",
  failures: "{count} échecs / 24 h",
  failuresTitle: "Rafraîchissements en échec au cours des dernières 24 heures",
  backlog: "en attente {count}",
  backlogTitle: "Réponses en attente de nouvelles tentatives de validation",
  durationSeconds: "{s} s",
  durationMinutes: "{m} min",
  durationHours: "{h} h {m} min",
};

export default healthFooter;
