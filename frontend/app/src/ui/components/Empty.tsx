import { Show, type Component } from "solid-js";
import css from "./Empty.module.css";

/** What an empty state says, in the caller's own words. */
export type EmptyText = {
  loading: string;
  notFound: string;
  error: string;
  retry: string;
};

/**
 * Stands in for a screen's content while a load is in flight, and after one
 * that found nothing or failed. The three states are distinguished here rather
 * than at the call sites, which otherwise each re-derive the same precedence:
 * an error outranks loading, and "not found" is only meaningful once loading
 * has finished without one.
 *
 * Strings arrive whole rather than by i18n namespace, so `t()` stays at the
 * call site (its keys remain greppable) and the dev widget host — the one
 * caller with no catalog — passes literals through the same door.
 */
export const Empty: Component<{
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  text: EmptyText;
}> = (props) => (
  <div class={css.empty}>
    <Show
      when={props.error}
      fallback={props.loading ? props.text.loading : props.text.notFound}
    >
      <div class={css.emptyError}>{props.text.error}</div>
      <button type="button" onClick={() => props.onRetry?.()} class={css.retry}>
        {props.text.retry}
      </button>
    </Show>
  </div>
);
