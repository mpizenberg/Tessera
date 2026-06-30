/**
 * French message catalog. Typed as `Dict`, and each namespace below is itself
 * typed against its English counterpart, so the compiler enforces key-for-key
 * parity with English. Code-split: this whole tree is loaded on demand the first
 * time French is selected (see ../index.ts), so it costs the default English
 * user nothing.
 */

import type { Dict } from "../en";
import appError from "./appError";
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

const fr: Dict = {
  appError,
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

export default fr;
