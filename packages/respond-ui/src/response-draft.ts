/**
 * The answering state machine: one reactive spine, two hosts.
 *
 * respond-core turns drafts into a response and back; the bodies in this package
 * render one question. Between them sits the state that decides *which* role is
 * answering, *what* the form currently holds, and *when* it must be reseeded —
 * and that is what both the Tessera app's Respond screen and the
 * `<tessera-respond>` widget need, identically.
 *
 * Everything host-specific enters as an accessor, so the app can feed it a
 * router param, a list snapshot and a lazily-fetched response bundle while the
 * widget feeds it props. What comes back is the whole spine, `drafts` included.
 *
 * The delicate part is reseeding. A form's identity is (survey, role,
 * credential) — the credential matters because a host may swap the responder to
 * a different wallet holding the same role, and wallet A's edits must never be
 * submitted under wallet B's credential. When that identity changes the previous
 * answers are stashed and the new identity's stash restored, so a misclick on a
 * role chip does not destroy work. When only the backing data changes, the form
 * is reseeded only while the user has not started editing.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  on,
  type Accessor,
} from "solid-js";
import { createStore } from "solid-js/store";

import type {
  Credential,
  Role,
  SurveyDefinition,
  SurveyRef,
  SurveyResponse,
} from "cip-179";
import { credentialKey, refKey } from "cip-179/domain";
import {
  credentialForRole,
  decided,
  findPriorResponse,
  hasAnyAnswer,
  initDraft,
  prefillDrafts,
  respondableRolesFor,
  type Draft,
  type DraftValue,
  type Responder,
} from "cardano-tessera-respond-core";

/** Where the host gets each input from is its own business; all are reactive. */
export interface ResponseDraftSource {
  /** The survey being answered — the display definition, if labels are enriched. */
  readonly definition: Accessor<SurveyDefinition | undefined>;
  /** Its on-chain reference, for prior-response matching and form identity. */
  readonly surveyRef: Accessor<SurveyRef | undefined>;
  /** Who is answering: the role→credential map, taken verbatim. */
  readonly responder: Accessor<Responder>;
  /** Already-submitted responses to match a prior against (deduped by the host). */
  readonly priorResponses: Accessor<readonly SurveyResponse[] | undefined>;
  /** Role to answer as when it is respondable here; else the first claimable. */
  readonly preferredRole: Accessor<Role | null | undefined>;
}

export interface ResponseDraft {
  /** Roles this responder may claim to this survey. */
  readonly respondable: Accessor<Role[]>;
  readonly role: Accessor<Role | null>;
  /** Answer as this role instead; ignored while it is not respondable. */
  readonly pickRole: (role: Role | null) => void;
  readonly credential: Accessor<Credential | null>;
  /** This responder's existing response for the current role, sealed included. */
  readonly prior: Accessor<SurveyResponse | undefined>;
  /** Identity of the form; changing it reseeds. Stable across data refreshes. */
  readonly formKey: Accessor<string>;
  /** One per question, index-aligned with `definition().questions`. */
  readonly drafts: readonly Draft[];
  readonly setValue: (index: number, value: DraftValue) => void;
  readonly setSkipped: (index: number, skipped: boolean) => void;
  readonly total: Accessor<number>;
  readonly decidedCount: Accessor<number>;
  /**
   * At least one question actually answered. Every-question-decided still allows
   * an all-skipped (all-optional) form, which is spec-invalid and drops at scan.
   */
  readonly answered: Accessor<boolean>;
}

export function createResponseDraft(
  source: ResponseDraftSource,
): ResponseDraft {
  const respondable = createMemo<Role[]>(() => {
    const def = source.definition();
    return def ? respondableRolesFor(def, source.responder()) : [];
  });

  const [roleOverride, setRoleOverride] = createSignal<Role | null>(null);
  const role = createMemo<Role | null>(() => {
    const rs = respondable();
    if (rs.length === 0) return null;
    const picked = roleOverride();
    if (picked !== null && rs.includes(picked)) return picked;
    const preferred = source.preferredRole();
    if (preferred != null && rs.includes(preferred)) return preferred;
    return rs[0]!;
  });

  const credential = createMemo<Credential | null>(() => {
    const r = role();
    return r !== null ? (credentialForRole(r, source.responder()) ?? null) : null;
  });

  const prior = createMemo<SurveyResponse | undefined>(() => {
    const ref = source.surveyRef();
    const responses = source.priorResponses();
    const r = role();
    const cred = credential();
    if (!ref || !responses || r === null || !cred) return undefined;
    return findPriorResponse(responses, ref, r, cred);
  });

  // Drafts can only be seeded from a public prior; a sealed one is known to
  // exist but unreadable, so its form starts pristine.
  const prefillFrom = createMemo<SurveyResponse | undefined>(() => {
    const p = prior();
    return p?.answers.type === "public" ? p : undefined;
  });

  // Store mirror of Draft with mutable fields so path setters typecheck.
  const [drafts, setDrafts] = createStore<
    { skipped: boolean; value: DraftValue }[]
  >([]);
  // True once the user edits; gates auto-(re)seeding so late-arriving data never
  // clobbers in-progress input.
  const [touched, setTouched] = createSignal(false);

  const surveyKey = createMemo(() => {
    const ref = source.surveyRef();
    return ref ? refKey(ref) : undefined;
  });
  const keyOf = (r: Role | null, cred: Credential | null): string =>
    `${r}:${cred ? credentialKey(cred) : ""}`;
  const formKey = createMemo(
    () => `${surveyKey() ?? ""}|${keyOf(role(), credential())}`,
  );

  // Kept for the hook's lifetime; cleared when the survey itself changes. Only
  // touched forms are stashed — a pristine one is reproduced exactly by reseeding.
  const stash = new Map<string, { skipped: boolean; value: DraftValue }[]>();

  createEffect(
    on(
      () =>
        [
          surveyKey(),
          role(),
          credential(),
          source.definition(),
          prefillFrom(),
        ] as const,
      ([key, r, cred], prev) => {
        if (prev && (prev[0] !== key || keyOf(prev[1], prev[2]) !== keyOf(r, cred))) {
          if (prev[0] !== key) stash.clear();
          else if (touched()) {
            // Draft values are replaced immutably on edit, so copying the
            // records detaches the stash from future store writes.
            stash.set(
              keyOf(prev[1], prev[2]),
              drafts.map((d) => ({ skipped: d.skipped, value: d.value })),
            );
          }
          const stashed = stash.get(keyOf(r, cred));
          if (stashed) {
            setTouched(true);
            setDrafts(stashed.map((d) => ({ ...d })));
            return;
          }
          setTouched(false);
        }
        if (touched()) return;
        const def = source.definition();
        if (!def) {
          setDrafts([]);
          return;
        }
        const ex = prefillFrom();
        setDrafts(
          ex ? prefillDrafts(def.questions, ex) : def.questions.map(initDraft),
        );
      },
    ),
  );

  const total = () => source.definition()?.questions.length ?? 0;
  const decidedCount = createMemo(() => {
    const def = source.definition();
    if (!def) return 0;
    return def.questions.filter((q, i) => drafts[i] && decided(q, drafts[i]!))
      .length;
  });
  const answered = createMemo(() => {
    const def = source.definition();
    return def ? hasAnyAnswer(def.questions, drafts) : false;
  });

  return {
    respondable,
    role,
    pickRole: setRoleOverride,
    credential,
    prior,
    formKey,
    drafts,
    setValue: (index, value) => {
      setTouched(true);
      setDrafts(index, "value", value);
    },
    setSkipped: (index, skipped) => {
      setTouched(true);
      setDrafts(index, "skipped", skipped);
    },
    total,
    decidedCount,
    answered,
  };
}
