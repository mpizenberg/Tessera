/**
 * Thin operational-health footer for the Explore screen (indexer mode only):
 * snapshot age, last-refresh Koios usage vs its budget, 24 h call volume, and
 * anything alarming (failed refresh, validation backlog). Display-only chrome —
 * it renders nothing in direct-Koios mode (no backend to report on) and hides
 * itself when the health fetch fails rather than adding an error of its own.
 */

import {
  Show,
  createSignal,
  onCleanup,
  type Component,
  type JSX,
} from "solid-js";

import { useApp } from "~/state";
import type { BackendHealth } from "~/data/source";
import { t, n } from "~/i18n";
import css from "./HealthFooter.module.css";

/**
 * Age past which the snapshot reads as stuck. Deliberately generous versus the
 * 3-minute refresh cadence (the client doesn't know the server's interval):
 * several consecutive refreshes must have failed to silently trip it.
 */
const STALE_AFTER_SECONDS = 900;

/** Warn when the last refresh used this fraction of its Koios budget. */
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

  // Live age from the fetch-time stamp: `ageSeconds` was true at fetch time,
  // and the wall clock has moved since — so tick it forward locally. This is
  // exactly what makes a wedged backend visible without refetching.
  const age = (): number | undefined => {
    const snap = health()?.snapshot;
    if (!snap) return undefined;
    const fetchedAgo = nowUnix() - (snap.fetchedAt + snap.ageSeconds);
    return snap.ageSeconds + Math.max(0, fetchedAgo);
  };

  const refreshRatio = (): number | undefined => {
    const h = health();
    if (!h?.lastRefresh || h.limits.koiosCallsPerRefresh <= 0) return undefined;
    return h.lastRefresh.koiosCalls / h.limits.koiosCallsPerRefresh;
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
                  title={t("healthFooter.koiosRefreshTitle")}
                >
                  {t("healthFooter.koiosRefresh", {
                    calls: n(run().koiosCalls),
                    limit: n(h().limits.koiosCallsPerRefresh),
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
