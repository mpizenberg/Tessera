/**
 * App-wide strip shown whenever reads bypass the backend and go straight to
 * Koios — the one place the user is told, on every screen, that what they see
 * is unverified (credential proofs and voting weights are only checked at
 * finalization). Two variants: the 24 h emergency activation (with its revert
 * time) and a build with no backend configured at all (permanent, so it points
 * at the independent verifier instead). The data source is fixed at boot, so
 * this renders from plain boot-time facts — no signals.
 */

import type { Component } from "solid-js";

import { directModeUntil, resolveIndexerUrl } from "~/config";
import { formatUnixDate } from "~/tlock/drand";
import { t } from "~/i18n";
import css from "./DirectModeBanner.module.css";

export const DirectModeBanner: Component = () => {
  if (resolveIndexerUrl() !== undefined) return null;
  const until = directModeUntil();
  return (
    <div class={css.banner} role="status">
      <b>{t(until ? "directBanner.emergencyStrong" : "directBanner.strong")}</b>{" "}
      {until
        ? t("directBanner.emergencyRest", {
            time: formatUnixDate(Math.floor(until / 1000)),
          })
        : t("directBanner.rest")}
    </div>
  );
};
