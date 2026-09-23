/**
 * The credentials a survey's snapshots must be asked about: every one its
 * responses name as a Stakeholder or a DRep, whether or not the rebuild will
 * count that response. Asking about too many is harmless; one left out makes
 * {@link AmaruTallyInputs} refuse the snapshot.
 */

import { Role } from "cip-179";
import { credentialKey, type SurveyBundle } from "cip-179/domain";

export interface AskedCredentials {
  readonly accounts: readonly string[];
  readonly dreps: readonly string[];
}

export function askedCredentials(
  window: Pick<SurveyBundle, "responses">,
): AskedCredentials {
  const keysOf = (role: Role) =>
    [
      ...new Set(
        window.responses
          .filter((r) => r.response.role === role)
          .map((r) => credentialKey(r.response.credential)),
      ),
    ].sort();
  return { accounts: keysOf(Role.Stakeholder), dreps: keysOf(Role.DRep) };
}
