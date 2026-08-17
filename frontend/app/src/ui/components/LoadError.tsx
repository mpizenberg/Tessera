import { type Component } from "solid-js";
import { useNavigate } from "@solidjs/router";

import { resolveIndexerUrl } from "~/config";
import { useApp } from "~/state";
import { t } from "~/i18n";
import css from "./LoadError.module.css";

/**
 * Recoverable fallback for the app-wide <ErrorBoundary>: shown when rendering a
 * screen throws — in practice a failed snapshot load. Which source failed
 * decides both the sentence and the advice, and the source is fixed at boot
 * (like {@link import("./DirectModeBanner").DirectModeBanner}), so it reads
 * from the same plain boot-time fact: naming Koios while reads flow through a
 * backend would send the reader to fix a token that is not in the path.
 *
 * The Header and bottom nav stay mounted around this, but a tripped
 * ErrorBoundary keeps showing the fallback regardless of route changes until it
 * is reset — so both actions here call `reset()`, which re-renders the (now
 * current) route:
 *  - **Retry** reloads the snapshot, then resets.
 *  - **Open Settings** navigates to Settings first, then resets, so the reader
 *    can fix the Koios token, point at another backend, or fall back to
 *    reading the chain directly.
 */
export const LoadError: Component<{ err: unknown; reset: () => void }> = (
  props,
) => {
  const app = useApp();
  const navigate = useNavigate();
  const indexerUrl = resolveIndexerUrl();
  return (
    <main class={css.wrap}>
      <div class={css.card}>
        <h1 class={css.title}>{t("appError.title")}</h1>
        <p class={css.body}>
          {indexerUrl
            ? t("appError.bodyBackend", {
                url: indexerUrl,
                error: String(props.err),
              })
            : t("appError.bodyKoios", { error: String(props.err) })}
        </p>
        <p class={css.hint}>
          {t(indexerUrl ? "appError.backendHint" : "appError.tokenHint")}
        </p>
        <div class={css.actions}>
          <button
            class={css.retry}
            onClick={() => {
              app.reload();
              props.reset();
            }}
          >
            {t("appError.retry")}
          </button>
          <button
            class={css.settings}
            onClick={() => {
              navigate("/settings");
              props.reset();
            }}
          >
            {t("appError.openSettings")}
          </button>
        </div>
      </div>
    </main>
  );
};
