import type { Messages } from "../en/healthFooter";

const healthFooter: Messages = {
  updated: "données datant de {age}",
  updatedStale: "données datant de {age} — rafraîchissement peut-être bloqué",
  updatedTitle: "Âge de l'instantané on-chain servi",
  refreshRequests: "requêtes {calls}/{limit}",
  refreshRequestsTitle:
    "Requêtes sortantes du dernier rafraîchissement — lectures Koios et récupérations d'ancres de gouvernance — rapportées au budget par rafraîchissement",
  koiosDaily: "Koios {calls} / 24 h",
  koiosDailyWithLimit: "Koios {calls}/{limit} / 24 h",
  koiosDailyTitle:
    "Requêtes sur l'identité Koios de l'opérateur au cours des dernières 24 heures — rafraîchissements comme lectures servies",
  passthroughDaily: "suivi {calls} / 24 h",
  passthroughDailyTitle:
    "Suivi des confirmations, sur son identité Koios dédiée : aucun afflux ne peut atteindre l'identité dont dépendent les données servies",
  upstreamDaily: "sortantes {calls} / 24 h",
  upstreamDailyTitle:
    "Toutes les requêtes sortantes des dernières 24 heures, tous services confondus",
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
