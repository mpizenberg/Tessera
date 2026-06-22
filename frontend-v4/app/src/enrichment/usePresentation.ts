/**
 * Solid binding for external-content enrichment.
 *
 * Given a (possibly undefined) survey definition, this lazily fetches and
 * verifies its presentation document and exposes the *display* definition:
 * enriched with off-chain labels once available, the on-chain definition
 * otherwise. Because every constraint stays on-chain, the on-chain fallback is
 * always usable — only labels are missing — so screens render immediately and
 * upgrade in place when the document resolves.
 *
 * The content fetcher (and its blake2b/JSON dependencies) is dynamically
 * imported so it stays out of the initial bundle.
 */

import { createResource, type Accessor } from "solid-js";
import type { SurveyDefinition } from "cip-179";

export interface PresentationState {
  /** Display definition: enriched when available, else the on-chain one. */
  readonly def: Accessor<SurveyDefinition | undefined>;
  /** True when the definition carries a content anchor (external-content mode). */
  readonly external: Accessor<boolean>;
  /** True while the presentation document is being fetched/verified. */
  readonly loading: Accessor<boolean>;
  /** Set when an anchor is present but couldn't be fetched or failed its hash. */
  readonly unavailable: Accessor<boolean>;
}

export function usePresentation(
  source: Accessor<SurveyDefinition | undefined>,
  gateway: string,
): PresentationState {
  const [enriched] = createResource(
    () => {
      const d = source();
      return d && d.contentAnchor ? d : null;
    },
    async (d) => {
      const { enrichDefinition } = await import("./content");
      return enrichDefinition(d, gateway);
    },
  );

  return {
    def: () => (enriched.state === "ready" ? enriched() : source()),
    external: () => !!source()?.contentAnchor,
    loading: () => enriched.loading,
    unavailable: () => !!enriched.error,
  };
}
