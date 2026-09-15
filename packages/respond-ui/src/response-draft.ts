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
 * The delicate part is seeding. A form's identity is (survey, role, credential)
 * — the credential matters because a host may swap the responder to a different
 * wallet holding the same role, and wallet A's edits must never be submitted
 * under wallet B's credential. Every edit is written to a stash under that
 * identity, and a form the user has not touched is seeded from the stash first,
 * then from a public prior response, then from defaults. So a misclick on a role
 * chip does not destroy work, and neither does a reload when the host's stash
 * outlives the page. When only the backing data changes, the form is reseeded
 * only while the user has not started editing.
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
  Question,
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
  /**
   * Where edited forms are kept. Defaults to memory, for as long as the spine
   * lives; a host passes a durable one to keep answers across reloads.
   */
  readonly stash?: DraftStash;
}

/** Edited forms by {@link ResponseDraft.formKey}, each written whole on every edit. */
export interface DraftStash {
  /** The form kept under `formKey`, unless there is none that fits `questions`. */
  get(
    formKey: string,
    questions: readonly Question[],
  ): readonly Draft[] | undefined;
  set(formKey: string, drafts: readonly Draft[]): void;
  delete(formKey: string): void;
}

function memoryStash(): DraftStash {
  const forms = new Map<string, readonly Draft[]>();
  return {
    get: (formKey) => forms.get(formKey),
    set: (formKey, drafts) => void forms.set(formKey, drafts),
    delete: (formKey) => void forms.delete(formKey),
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
  /** Identity of the form; changing it reseeds. Stable across data refreshes. */
  readonly formKey: Accessor<string>;
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
  const stash = source.stash ?? memoryStash();

  const surveyKey = createMemo(() => {
    const ref = source.surveyRef();
    return ref ? refKey(ref) : undefined;
  });
  const formKey = createMemo(() => {
    const r = role();
    const cred = credential();
    return `${surveyKey() ?? ""}|${r}:${cred ? credentialKey(cred) : ""}`;
  });

  const seed = () => {
    const def = source.definition();
    const kept = def && stash.get(formKey(), def.questions);
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
      () => [formKey(), source.definition(), prefillFrom()] as const,
      ([key], prev) => {
        if (prev && prev[0] !== key) setTouched(false);
        if (!touched()) seed();
      },
    ),
  );

  // The record is set rather than the path to its `value`: a path set merges
  // into the old value object in place, which would change the answers under
  // anyone holding an earlier snapshot — the stash, or a submission awaiting
  // its signature.
  const edit = (index: number, change: Partial<Draft>) => {
    setTouched(true);
    setDrafts(index, change);
    stash.set(
      formKey(),
      unwrap(drafts).map((d) => ({ skipped: d.skipped, value: d.value })),
    );
  };

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
    setValue: (index, value) => edit(index, { value }),
    setSkipped: (index, skipped) => edit(index, { skipped }),
    restored,
    discard: () => {
      stash.delete(formKey());
      seed();
    },
    total,
    decidedCount,
    answered,
  };
}
