/**
 * English message catalog — the source of truth for all UI copy, assembled from
 * one module per UI namespace (screen or component).
 *
 * `Dict = typeof en` is the contract every other locale must satisfy: each
 * `fr/<ns>.ts` is typed against its `en/<ns>.ts` counterpart, and `fr/index.ts`
 * is typed as `Dict`, so the build fails unless every locale defines *exactly*
 * these keys — no missing, no extra, no typos.
 *
 * Per-namespace module convention (see ./onchainPreview.ts for the canonical
 * example):
 *  - `const ns = { … }; export type Messages = typeof ns; export default ns;`
 *  - Messages are plain strings (translator- and tooling-friendly), with
 *    `{placeholder}` tokens filled at call time by `t(key, params)`.
 *  - Keep each message a *whole* phrase, never concatenated fragments — a
 *    translator must be free to reorder it. Splice variable mid-sentence clauses
 *    in as their own sub-messages (see onchainPreview.noteSealed / *Padding).
 *
 * Adding a namespace: create `en/<ns>.ts` + `fr/<ns>.ts`, then register it in
 * both this file and `fr/index.ts`.
 */

import bottomNav from "./bottomNav";
import create from "./create";
import explore from "./explore";
import feedback from "./feedback";
import header from "./header";
import onchainPreview from "./onchainPreview";
import proposeInfoAction from "./proposeInfoAction";
import respond from "./respond";
import settings from "./settings";
import submitProgress from "./submitProgress";
import survey from "./survey";
import txLink from "./txLink";

const en = {
  bottomNav,
  create,
  explore,
  feedback,
  header,
  onchainPreview,
  proposeInfoAction,
  respond,
  settings,
  submitProgress,
  survey,
  txLink,
};

export type Dict = typeof en;
export default en;
