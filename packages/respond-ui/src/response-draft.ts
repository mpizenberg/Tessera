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
 * The delicate part is seeding. There is one form per survey: the answers
 * belong to the person filling it in, so switching role or wallet — most often
 * a correction — keeps what they have written. Every edit is written to a stash
 * under the survey's key, and a form the user has not touched is seeded from
 * the stash first, then from the current role's public prior response, then
 * from defaults. So a reload does not lose work when the host's stash outlives
 * the page. While the user has not started editing, the form follows the
 * backing data and the chosen role; once they have, only another survey
 * reseeds it.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  on,
  type Accessor,
} from "solid-js";
import { createStore, unwrap } from "solid-js/store";

import type {
  Credential,
  Role,
  SurveyDefinition,
  SurveyRef,
  SurveyResponse,
} from "cip-179";
import { refKey } from "cip-179/domain";
import {
  credentialForRole,
  decided,
  decodeKeptForm,
  encodeKeptForm,
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
  /** Its on-chain reference, for prior-response matching and the stash key. */
  readonly surveyRef: Accessor<SurveyRef | undefined>;
  /** Who is answering: the role→credential map, taken verbatim. */
  readonly responder: Accessor<Responder>;
  /** Already-submitted responses to match a prior against (deduped by the host). */
  readonly priorResponses: Accessor<readonly SurveyResponse[] | undefined>;
  /** Role to answer as when it is respondable here; else the first claimable. */
  readonly preferredRole: Accessor<Role | null | undefined>;
  /** Cap on a custom answer's UTF-8 length; a longer one is not decided. */
  readonly maxTextBytes?: Accessor<number | undefined>;
  /**
   * Where edited forms are kept. Defaults to memory, for as long as the spine
   * lives; a host passes a durable one to keep answers across reloads. A
   * stash arriving after the form did restores into it while it is untouched.
   */
  readonly stash?: Accessor<DraftStash | undefined>;
}

/**
 * Edited forms by survey key (`<txHash>:<index>`), each written whole on every
 * edit as plain JSON. What `get` returns is checked against the questions, so
 * a form that no longer fits them is refused, not restored.
 */
export interface DraftStash {
  /** The form last set under `surveyKey`, or `undefined`. */
  get(surveyKey: string): unknown;
  set(surveyKey: string, form: unknown): void;
  delete(surveyKey: string): void;
}

function memoryStash(): DraftStash {
  const forms = new Map<string, unknown>();
  return {
    get: (surveyKey) => forms.get(surveyKey),
    set: (surveyKey, form) => void forms.set(surveyKey, form),
    delete: (surveyKey) => void forms.delete(surveyKey),
  };
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
  /** One per question, index-aligned with `definition().questions`. */
  readonly drafts: readonly Draft[];
  readonly setValue: (index: number, value: DraftValue) => void;
  readonly setSkipped: (index: number, skipped: boolean) => void;
  /** The form was seeded from the stash, not from a prior response or defaults. */
  readonly restored: Accessor<boolean>;
  /** Forget this form's stashed answers and reseed from the prior or defaults. */
  readonly discard: () => void;
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
    return r !== null
      ? (credentialForRole(r, source.responder()) ?? null)
      : null;
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
  const [restored, setRestored] = createSignal(false);
  const fallback = memoryStash();
  const stash = () => source.stash?.() ?? fallback;

  const surveyKey = createMemo(() => {
    const ref = source.surveyRef();
    return ref ? refKey(ref) : undefined;
  });

  const seed = () => {
    const def = source.definition();
    const key = surveyKey();
    const kept =
      def && key !== undefined
        ? decodeKeptForm(stash().get(key), def.questions)
        : undefined;
    // A kept form counts as edited, so a prior response arriving later cannot
    // replace it.
    setTouched(kept !== undefined);
    setRestored(kept !== undefined);
    if (!def) setDrafts([]);
    else if (kept) {
      setDrafts(kept.map((d) => ({ skipped: d.skipped, value: d.value })));
    } else {
      const ex = prefillFrom();
      setDrafts(
        ex ? prefillDrafts(def.questions, ex) : def.questions.map(initDraft),
      );
    }
  };

  createEffect(
    on(
      () => [surveyKey(), source.definition(), prefillFrom(), stash()] as const,
      ([key], prev) => {
        if (prev && prev[0] !== key) setTouched(false);
        if (!touched()) seed();
      },
    ),
  );

  // The record is set rather than the path to its `value`: a path set merges
  // into the old value object in place, which would change the answers under
  // anyone holding an earlier snapshot, such as a submission awaiting its
  // signature.
  const edit = (index: number, change: Partial<Draft>) => {
    setTouched(true);
    setDrafts(index, change);
    const key = surveyKey();
    if (key !== undefined) stash().set(key, encodeKeptForm(unwrap(drafts)));
  };

  const total = () => source.definition()?.questions.length ?? 0;
  const decidedCount = createMemo(() => {
    const def = source.definition();
    if (!def) return 0;
    const max = source.maxTextBytes?.();
    return def.questions.filter(
      (q, i) => drafts[i] && decided(q, drafts[i]!, max),
    ).length;
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
    drafts,
    setValue: (index, value) => edit(index, { value }),
    setSkipped: (index, skipped) => edit(index, { skipped }),
    restored,
    discard: () => {
      const key = surveyKey();
      if (key !== undefined) stash().delete(key);
      seed();
    },
    total,
    decidedCount,
    answered,
  };
}
