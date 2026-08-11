import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { SurveyDefinition } from "cip-179";
import { voteDeadlineUnix } from "cip-179/domain";

import { useApp } from "~/state";
import { t, n } from "~/i18n";

export type Deadline = {
  /**
   * Whether voting has closed as of `atUnix`. Takes its clock explicitly: the
   * display ticks once a minute, the submit gate must read the live time.
   */
  readonly passed: (atUnix: number) => boolean;
  /** {@link passed} against the ticking clock — reactive, for gating display. */
  readonly passedNow: Accessor<boolean>;
  /** Set while the deadline is close enough that signing at leisure misses it. */
  readonly warning: Accessor<string | undefined>;
};

/**
 * When this survey stops accepting answers. The chain tip is only sampled when
 * the survey list loads, so a tab left open across the deadline would otherwise
 * keep offering a submit whose fee buys an excluded response — hence the clock.
 *
 * Unknown while the tip is (a failed list load, an optimistic survey): then
 * nothing here gates, and the aggregate's own status is all we have.
 */
export function createDeadline(
  definition: Accessor<SurveyDefinition | undefined>,
): Deadline {
  const app = useApp();

  const [nowUnix, setNowUnix] = createSignal(Math.floor(Date.now() / 1000));
  const clock = setInterval(
    () => setNowUnix(Math.floor(Date.now() / 1000)),
    60_000,
  );
  onCleanup(() => clearInterval(clock));

  const deadlineUnix = createMemo<number | undefined>(() => {
    const def = definition();
    const tip = (app.list.error ? undefined : app.list())?.tip;
    if (!def || !tip) return undefined;
    return voteDeadlineUnix(def.endEpoch, tip, app.config.secondsPerEpoch);
  });

  const passed = (atUnix: number): boolean => {
    const d = deadlineUnix();
    return d !== undefined && atUnix >= d;
  };

  return {
    passed,
    passedNow: () => passed(nowUnix()),
    warning: () => {
      const d = deadlineUnix();
      if (d === undefined) return undefined;
      const left = d - nowUnix();
      if (left <= 0 || left > 10 * 60) return undefined;
      return t("respond.deadlineSoon", { m: n(Math.ceil(left / 60)) });
    },
  };
}
