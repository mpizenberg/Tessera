/** Explore screen — the surveys & polls register. */

const explore = {
  // Filter chips (the toolbar tabs).
  filterAll: "All",
  filterLinked: "Governance",
  filterActive: "Active",
  filterSealed: "Sealed",
  filterPublic: "Public",
  filterMine: "Mine",

  // "Ends" cell: coarse time-left while open, lifecycle word once closed.
  endingNow: "ending now",
  /** {d} days, {h} hours — shown when more than a day remains. */
  timeLeftDaysHours: "{d}d {h}h left",
  /** {h} hours, {m} minutes — shown in the final day. */
  timeLeftHoursMinutes: "{h}h {m}m left",
  /** {m} minutes — shown in the final hour (never below 1). */
  timeLeftMinutes: "{m}m left",
  endsWithdrawn: "withdrawn",
  endsClosed: "closed",

  // Title row + summary.
  pageTitle: "Surveys & polls",
  /** {count} entries, {epoch} is the current chain epoch. */
  summary: "{count} entries · current epoch {epoch}",
  newSurvey: "New survey",

  searchPlaceholder: "Search surveys…",

  // Table header cells.
  headerForm: "Form",
  headerAnsweredTitle: "Surveys you have answered",
  headerSurvey: "Survey",
  headerEligible: "Eligible",
  headerEnds: "Ends",
  headerReplies: "Replies",

  /** {error} is the raw error string. */
  loadError: "Failed to load: {error}",
  incomplete:
    "Showing the most recent surveys and responses — more exist on-chain than could be loaded, so some lists and tallies may be incomplete.",

  // Section labels splitting the register.
  sectionGov: "On-chain governance",
  sectionGovNote: "Tied to an Info Action — shown first.",
  sectionOpen: "Open · accepting responses",
  sectionClosed: "Closed",
  sectionClosedNote: "Ended or withdrawn — read-only.",

  noMatch: "No surveys match.",

  // Per-row badges and fallbacks.
  answeredTitle: "You answered this survey",
  answeredAria: "answered",
  badgeYours: "Yours",
  badgeOffChain: "⚠ labels off-chain",
  /** {id} is the shortened governance action id. */
  govInfoAction: "Info Action {id}",
  /** Spliced after govInfoAction when a linked-action title is known; {title} is user content. */
  govInfoActionTitle: " · {title}",
  untitled: "Untitled · external content",
  noPresentation: "Presentation text unavailable — on-chain structure intact.",
  refTitle: "Full survey ref — defining transaction hash and output index",
  /** {epoch} is the raw end-epoch number. */
  refEpoch: "epoch {epoch}",
  /** {ref} is the full survey ref. */
  refLabel: "ref {ref}",

  // Card-mode meta chips.
  metaForm: "Form",
  metaEligible: "Eligible",
  metaEnds: "Ends",
  metaReplies: "Replies",
  metaEpoch: "Epoch",

  // Legend.
  legendForm: "Form — one tile per question.",
  legendPublic: "public",
  legendSealed: "sealed until reveal",
  legendAnswered: "you answered",

  // First-visit intro hero.
  introDismiss: "Dismiss",
  introTitle: "On-chain surveys & polls on Cardano",
  introBody:
    "Tessera records surveys directly in Cardano transaction metadata — no backend, no accounts. Browse everything below for free; connect a wallet to respond as your on-chain role (DRep, SPO, CC, or stakeholder) or to publish your own. Responses can be public or sealed — timelock-encrypted for a delayed reveal.",
};

export type Messages = typeof explore;
export default explore;
