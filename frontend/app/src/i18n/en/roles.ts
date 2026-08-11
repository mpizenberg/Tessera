/**
 * One-line explanation of what each CIP-179 role is and how it's claimed —
 * `respond-core`'s catalog verbatim. The ineligible-roles list the app shows is
 * the same one the `<tessera-respond>` widget shows, so it reads the same words.
 */

import { enMessages } from "cardano-tessera-respond-core";

const roles = enMessages.roles;

export type Messages = typeof roles;
export default roles;
