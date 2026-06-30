import { type Component } from "solid-js";
import { useNavigate } from "@solidjs/router";

import { useApp } from "~/state";
import { t } from "~/i18n";
import css from "./LoadError.module.css";

/**
 * Recoverable fallback for the app-wide <ErrorBoundary>: shown when rendering a
 * screen throws — in practice almost always a failed snapshot load (a Koios
 * read: bad/expired token, rate-limit, CORS, or timeout). The Header and bottom
 * nav stay mounted around this, but a tripped ErrorBoundary keeps showing the
 * fallback regardless of route changes until it is reset — so both actions here
 * call `reset()`, which re-renders the (now-current) route:
 *  - **Retry** reloads the snapshot with the current token, then resets.
 *  - **Open Settings** navigates to Settings first, then resets, so the user can
 *    fix their Koios token; saving it there reloads the snapshot successfully.
 */
export const LoadError: Component<{ err: unknown; reset: () => void }> = (
  props,
) => {
  const app = useApp();
  const navigate = useNavigate();
  return (
    <main class={css.wrap}>
      <div class={css.card}>
        <h1 class={css.title}>{t("appError.title")}</h1>
        <p class={css.body}>
          {t("appError.body", { error: String(props.err) })}
        </p>
        <p class={css.hint}>{t("appError.tokenHint")}</p>
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
