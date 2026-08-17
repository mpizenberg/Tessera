/** Thin operational-health footer under the Explore register (indexer mode). */

const healthFooter = {
  // Snapshot freshness (age is a preformatted duration like "3 m").
  updated: "data {age} old",
  updatedStale: "data {age} old — refresh may be stuck",
  updatedTitle: "How old the served on-chain snapshot is",
  // Everything the last refresh sent upstream, against the platform's
  // per-invocation cap when the operator declared one.
  refreshRequests: "requests {calls}",
  refreshRequestsWithCap: "requests {calls}/{limit}",
  refreshRequestsTitle:
    "Upstream requests made by the last refresh — Koios reads and governance-anchor fetches — against the platform's per-invocation cap",
  // Rolling 24 h volumes, one per upstream identity. Every service meters us
  // over a day of its own; only Koios has a quota the operator can tell us.
  koiosDaily: "Koios {calls} / 24 h",
  koiosDailyWithLimit: "Koios {calls}/{limit} / 24 h",
  koiosDailyTitle:
    "Requests on the operator's Koios identity over the last 24 hours — refreshes and served reads alike",
  passthroughDaily: "polling {calls} / 24 h",
  passthroughDailyTitle:
    "Confirmation polling, on its own Koios identity so no flood of it can reach the identity the served data depends on",
  upstreamDaily: "upstream {calls} / 24 h",
  upstreamDailyTitle:
    "Every upstream request of the last 24 hours, all services together",
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
