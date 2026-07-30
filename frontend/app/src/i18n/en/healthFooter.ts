/** Thin operational-health footer under the Explore register (indexer mode). */

const healthFooter = {
  // Snapshot freshness (age is a preformatted duration like "3 m").
  updated: "data {age} old",
  updatedStale: "data {age} old — refresh may be stuck",
  updatedTitle: "How old the served on-chain snapshot is",
  // Upstream request usage of the last refresh vs the per-refresh budget.
  koiosRefresh: "Koios {calls}/{limit}",
  koiosRefreshTitle:
    "Upstream requests made by the last refresh — Koios reads and governance-anchor fetches — against the per-refresh budget",
  // Rolling 24 h call volume (with or without a configured daily quota).
  koiosDaily: "{calls} calls / 24 h",
  koiosDailyWithLimit: "{calls}/{limit} calls / 24 h",
  koiosDailyTitle:
    "Upstream requests across all refreshes of the last 24 hours",
  // Refresh outcomes.
  lastFailed: "last refresh failed",
  failures: "{count} failed / 24 h",
  failuresTitle: "Refresh runs that failed in the last 24 hours",
  // Validation backlog (shown only when nonzero).
  backlog: "backlog {count}",
  backlogTitle: "Responses still awaiting validation retries",
  // Duration units for the age readout.
  durationSeconds: "{s} s",
  durationMinutes: "{m} m",
  durationHours: "{h} h {m} m",
};

export type Messages = typeof healthFooter;
export default healthFooter;
