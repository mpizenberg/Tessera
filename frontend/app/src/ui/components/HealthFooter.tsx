/**
 * Thin operational-health footer for the Explore screen (indexer mode only):
 * snapshot age, the last refresh's upstream usage against its budget, 24 h
 * volume per upstream identity, and anything alarming (failed refresh,
 * validation backlog). Display-only chrome — it renders nothing in direct-Koios
 * mode (no backend to report on) and hides itself when the health fetch fails
 * rather than adding an error of its own.
 */

import {
  Show,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js";

import { useApp } from "~/state";
import type { BackendHealth } from "cardano-tessera-core";
import { t, n } from "~/i18n";
import css from "./HealthFooter.module.css";

/**
 * Age past which the snapshot reads as stuck. Deliberately generous versus the
 * 3-minute refresh cadence (the client doesn't know the server's interval):
 * several consecutive refreshes must have failed to silently trip it.
 */
const STALE_AFTER_SECONDS = 900;

/** Warn when the last refresh used this fraction of its request budget. */
const WARN_RATIO = 0.8;

/** Re-derive the live snapshot age at this cadence. */
const TICK_MS = 30_000;

function duration(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return t("healthFooter.durationSeconds", { s: n(s) });
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 1) return t("healthFooter.durationMinutes", { m: n(m) });
  return t("healthFooter.durationHours", { h: n(h), m: n(m) });
}

/** One separated readout; `tone` drives the warning/danger color. */
const Item: Component<{
  tone?: "warn" | "danger" | undefined;
  title?: string | undefined;
  children: JSX.Element;
}> = (props) => (
  <span
    class={css.item}
    classList={{
      [css.itemWarn]: props.tone === "warn",
      [css.itemDanger]: props.tone === "danger",
    }}
    title={props.title}
  >
    {props.children}
  </span>
);

export const HealthFooter: Component = () => {
  const app = useApp();
  // Same guarded-read pattern as Explore's snapData: `.error` first, so a
  // failed health fetch collapses the footer instead of throwing.
  const health = (): BackendHealth | undefined =>
    app.health.error ? undefined : (app.health() ?? undefined);

  const [nowUnix, setNowUnix] = createSignal(Math.floor(Date.now() / 1000));
  const clock = setInterval(
    () => setNowUnix(Math.floor(Date.now() / 1000)),
    TICK_MS,
  );
  onCleanup(() => clearInterval(clock));

  // `ageSeconds` was true when the backend answered, and the wall clock has
  // moved since — so tick it forward locally. This is exactly what makes a
  // wedged backend visible without refetching.
  const age = (): number | undefined => {
    const snap = health()?.snapshot;
    if (!snap) return undefined;
    const fetchedAgo = nowUnix() - (snap.fetchedAt + snap.ageSeconds);
    return snap.ageSeconds + Math.max(0, fetchedAgo);
  };

  // Against the *upstream* count, not the Koios one: the per-refresh budget is
  // the Worker's subrequest cap, which every outbound request spends.
  const refreshRatio = (): number | undefined => {
    const h = health();
    if (!h?.lastRefresh || h.limits.upstreamRequestsPerRefresh <= 0)
      return undefined;
    return h.lastRefresh.upstreamRequests / h.limits.upstreamRequestsPerRefresh;
  };
  const usageTone = (ratio: number): "warn" | "danger" | undefined =>
    ratio >= 1 ? "danger" : ratio >= WARN_RATIO ? "warn" : undefined;

  return (
    <Show when={health()}>
      {(h) => (
        <footer class={css.footer}>
          <Show when={age() !== undefined}>
            <Item
              tone={(age() ?? 0) > STALE_AFTER_SECONDS ? "warn" : undefined}
              title={t("healthFooter.updatedTitle")}
            >
              {t(
                (age() ?? 0) > STALE_AFTER_SECONDS
                  ? "healthFooter.updatedStale"
                  : "healthFooter.updated",
                { age: duration(age() ?? 0) },
              )}
            </Item>
          </Show>

          <Show when={h().lastRefresh}>
            {(run) => (
              <>
                <Item
                  tone={usageTone(refreshRatio() ?? 0)}
                  title={t("healthFooter.refreshRequestsTitle")}
                >
                  {t("healthFooter.refreshRequests", {
                    calls: n(run().upstreamRequests),
                    limit: n(h().limits.upstreamRequestsPerRefresh),
                  })}
                </Item>
                <Show when={!run().ok}>
                  <Item tone="danger" title={run().error ?? undefined}>
                    {t("healthFooter.lastFailed")}
                  </Item>
                </Show>
              </>
            )}
          </Show>

          <Item title={t("healthFooter.koiosDailyTitle")}>
            {h().limits.koiosCallsPerDay !== null
              ? t("healthFooter.koiosDailyWithLimit", {
                  calls: n(h().last24h.koiosCalls),
                  limit: n(h().limits.koiosCallsPerDay ?? 0),
                })
              : t("healthFooter.koiosDaily", {
                  calls: n(h().last24h.koiosCalls),
                })}
          </Item>

          {/* The comfort identity earns a readout of its own only once it has
              spent something — it is idle on a backend nobody is submitting to,
              and a spike there is the one worth noticing. */}
          <Show when={h().last24h.passthroughCalls > 0}>
            <Item title={t("healthFooter.passthroughDailyTitle")}>
              {t("healthFooter.passthroughDaily", {
                calls: n(h().last24h.passthroughCalls),
              })}
            </Item>
          </Show>

          <Item title={t("healthFooter.upstreamDailyTitle")}>
            {t("healthFooter.upstreamDaily", {
              calls: n(h().last24h.upstreamRequests),
            })}
          </Item>

          <Show when={h().last24h.failures > 0}>
            <Item tone="warn" title={t("healthFooter.failuresTitle")}>
              {t("healthFooter.failures", { count: n(h().last24h.failures) })}
            </Item>
          </Show>

          <Show when={h().validationBacklog > 0}>
            <Item tone="warn" title={t("healthFooter.backlogTitle")}>
              {t("healthFooter.backlog", { count: n(h().validationBacklog) })}
            </Item>
          </Show>
        </footer>
      )}
    </Show>
  );
};
