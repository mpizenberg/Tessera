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
import cart from "./cart";
import create from "./create";
import directBanner from "./directBanner";
import explore from "./explore";
import feedback from "./feedback";
import header from "./header";
import healthFooter from "./healthFooter";
import linkSurvey from "./linkSurvey";
import onchainPreview from "./onchainPreview";
import respond from "./respond";
import roles from "./roles";
import settings from "./settings";
import submitProgress from "./submitProgress";
import survey from "./survey";
import txLink from "./txLink";
import validation from "./validation";

const fr: Dict = {
  appError,
  bottomNav,
  cart,
  create,
  directBanner,
  explore,
  feedback,
  header,
  healthFooter,
  linkSurvey,
  onchainPreview,
  respond,
  roles,
  settings,
  submitProgress,
  survey,
  txLink,
  validation,
};

export default fr;
