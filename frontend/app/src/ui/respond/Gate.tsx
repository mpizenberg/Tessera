/**
 * Who may answer, and what stands in for the form when they may not. Every
 * refusal renders a {@link Notice} — the same card the screen uses for its own
 * warnings — so a voter meets one shape whatever turned them away.
 */

import { For, Show, type Component, type JSX } from "solid-js";
import type { Role, SurveyDefinition } from "cip-179";
import type { SurveyAggregate } from "cip-179/domain";

import {
  roleBrowserClaimable,
  roleColors,
  roleDescription,
  roleLabel,
  viewStatus,
} from "~/ui/format";
import { t } from "~/i18n";
import css from "./respond.module.css";

/** Renders the form (children) only when open, public, connected, and eligible. */
export const FormGate: Component<{
  s: SurveyAggregate;
  connected: boolean;
  respondable: Role[];
  children: JSX.Element;
}> = (props) => {
  const v = () => viewStatus(props.s);
  // Both "public" and "sealed" are open/active — sealed just encrypts on submit.
  return (
    <Show
      when={v() === "public" || v() === "sealed"}
      fallback={<ClosedNotice v={v()} />}
    >
      <Show when={props.connected} fallback={<ConnectPrompt />}>
        <Show
          when={props.respondable.length > 0}
          fallback={<Ineligible def={props.s.record.definition} />}
        >
          {props.children}
        </Show>
      </Show>
    </Show>
  );
};

const ClosedNotice: Component<{ v: ReturnType<typeof viewStatus> }> = (
  props,
) => (
  <Notice
    tone="muted"
    title={
      props.v === "invalid"
        ? t("respond.untalliableTitle")
        : props.v === "cancelled"
          ? t("respond.closedCancelledTitle")
          : t("respond.closedTitle")
    }
    body={
      props.v === "invalid"
        ? t("respond.untalliableBody")
        : props.v === "cancelled"
          ? t("respond.closedCancelledBody")
          : t("respond.closedBody")
    }
  />
);

const ConnectPrompt: Component = () => (
  <Notice
    tone="muted"
    title={t("respond.connectTitle")}
    body={t("respond.connectBody")}
  />
);

const Ineligible: Component<{ def: SurveyDefinition }> = (props) => (
  <div class={css.card}>
    <h3 class={css.ineligibleTitle}>{t("respond.ineligibleTitle")}</h3>
    <p class={css.ineligibleLead}>{t("respond.ineligibleLead")}</p>
    <div class={css.ineligibleList}>
      <For each={props.def.eligibleRoles}>
        {(r) => {
          const [color, bg] = roleColors(r);
          return (
            <div class={css.ineligibleRow}>
              <span class={css.roleChip} style={{ color, background: bg }}>
                {roleLabel(r)}
              </span>
              <span class={css.roleDesc}>
                {roleDescription(r)}
                <Show when={!roleBrowserClaimable(r)}>
                  <span class={css.notClaimable}>
                    {t("respond.notClaimable")}
                  </span>
                </Show>
              </span>
            </div>
          );
        }}
      </For>
    </div>
  </div>
);

export const Notice: Component<{
  tone: "warn" | "muted";
  title: string;
  body: string;
}> = (props) => (
  <div
    class={css.notice}
    classList={{ [css.noticeWarn]: props.tone === "warn" }}
  >
    <div
      class={css.noticeTitle}
      classList={{ [css.noticeTitleWarn]: props.tone === "warn" }}
    >
      {props.title}
    </div>
    <p class={css.noticeBody}>{props.body}</p>
  </div>
);
