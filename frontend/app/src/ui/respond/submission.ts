/**
 * What this form will put on chain: measured for the Pro preview, and actually
 * put there by the submit path. The two live together because they build the
 * same response from the same pieces — changing that shape has to change both.
 */

import {
  createMemo,
  createResource,
  createSignal,
  type Accessor,
} from "solid-js";
import {
  encodeAnswerItem,
  encodePayload,
  validateResponse,
  type ContentAnchor,
  type Credential,
  type Metadatum,
  type Role,
  type SealedSubmissionMode,
  type SurveyDefinition,
  type SurveyRef,
} from "cip-179";
import { sealAnswers, sealedCiphertextSize } from "cip-179/tlock";
import {
  buildResponse,
  buildSealedResponse,
  collectAnswers,
  type Draft,
} from "cardano-tessera-respond-core";

import { useApp } from "~/state";
import type { SubmitStep } from "~/ui/components/SubmitProgress";
import type { Action } from "~/wallet/action";
import { t } from "~/i18n";
import { problemText } from "~/i18n/problem";
import type { Deadline } from "./deadline";
import type { Rationale } from "./Rationale";

/** The survey, who is answering it, and what they answered. */
export type ResponseSource = {
  readonly definition: Accessor<SurveyDefinition | undefined>;
  readonly surveyRef: Accessor<SurveyRef | undefined>;
  readonly role: Accessor<Role | null>;
  readonly credential: Accessor<Credential | null>;
  readonly drafts: readonly Draft[];
  readonly sealedMode: Accessor<SealedSubmissionMode | null>;
};

type Parts = {
  readonly def: SurveyDefinition;
  readonly ref: SurveyRef;
  readonly role: Role;
  readonly credential: Credential;
};

/**
 * Everything a response is built from, or `undefined` while any piece is
 * missing — the survey may still be loading, no wallet may be connected, and no
 * role is claimable until both are true.
 */
function partsOf(src: ResponseSource): Parts | undefined {
  const def = src.definition();
  const ref = src.surveyRef();
  const role = src.role();
  const credential = src.credential();
  return def && ref && role !== null && credential
    ? { def, ref, role, credential }
    : undefined;
}

export type OnchainPreview = {
  /** The metadatum the response will carry, as far as it can be known cheaply. */
  readonly payload: Accessor<Metadatum | undefined>;
  /** What a sealed ciphertext is zero-padded to, for the preview's note. */
  readonly paddingSize: Accessor<number | undefined>;
  /** True on-chain byte size of a sealed submission; undefined for public. */
  readonly onchainSize: Accessor<number | undefined>;
};

/** The Pro-mode read of what submitting would publish. Never encrypts anything. */
export function createOnchainPreview(
  src: ResponseSource,
  rationale: Rationale,
): OnchainPreview {
  const app = useApp();

  // Public surveys: the payload is built live from the current drafts.
  const publicPayload = createMemo<Metadatum | undefined>(() => {
    if (!app.ui.pro || src.sealedMode()) return undefined;
    const p = partsOf(src);
    if (!p) return undefined;
    try {
      const response = buildResponse(
        p.ref,
        p.role,
        p.credential,
        p.def.questions,
        src.drafts,
        rationale.preview(),
      );
      return encodePayload({ type: "responses", responses: [response] });
    } catch {
      return undefined;
    }
  });

  // Sealed surveys: the on-chain payload is the timelock ciphertext, but we do
  // NOT encrypt for the preview — encryption runs only when the voter submits.
  // Instead we show the *plaintext answers* that will be sealed (the exact
  // metadatum fed to the timelock), built live and cheaply, with no tlock load.
  const sealedAnswers = createMemo<Metadatum | undefined>(() => {
    const def = src.definition();
    if (!def || !src.sealedMode()) return undefined;
    try {
      return collectAnswers(def.questions, src.drafts).map(encodeAnswerItem);
    } catch {
      return undefined;
    }
  });

  // The CBOR encoder is in the wallet seam (lazy) — load it once to measure the
  // real on-chain size of a sealed response without encrypting anything.
  const [cborMod] = createResource(() => import("~/wallet/cbor"));

  // The plaintext is padded to `padding_size` (or its own CBOR length if
  // larger), encrypted to a ciphertext of the analytically-known size, and
  // wrapped in the label-17 response envelope. We measure that envelope with a
  // zero-filled placeholder ciphertext — the same length as the real one — so
  // the preview can show size and fee before submit, with no tlock load.
  const onchainSize = createMemo<number | undefined>(() => {
    const mod = cborMod();
    const sealed = src.sealedMode();
    const answers = sealedAnswers();
    const p = partsOf(src);
    if (!mod || !sealed || !answers || !p) return undefined;
    try {
      const plaintextLen = Math.max(
        mod.metadatumToCbor(answers).length,
        sealed.paddingSize,
      );
      const ciphertext = new Uint8Array(
        sealedCiphertextSize(plaintextLen, sealed.round),
      );
      const response = buildSealedResponse(
        p.ref,
        p.role,
        p.credential,
        ciphertext,
        rationale.preview(),
      );
      const payload = encodePayload({
        type: "responses",
        responses: [response],
      });
      return mod.metadatumToCbor(payload).length;
    } catch {
      return undefined;
    }
  });

  return {
    payload: () => (src.sealedMode() ? sealedAnswers() : publicPayload()),
    paddingSize: () => src.sealedMode()?.paddingSize,
    onchainSize,
  };
}

export type Submission = {
  readonly submitting: Accessor<boolean>;
  readonly busyText: Accessor<string>;
  readonly stepKey: Accessor<string | null>;
  /** The ordered steps this submission runs through, driving the overlay. */
  readonly steps: Accessor<SubmitStep[]>;
  readonly problems: Accessor<string[]>;
  readonly error: Accessor<string | null>;
  readonly txHash: Accessor<string | null>;
  readonly queued: Accessor<boolean>;
  /** Whether submitting adds to the cart instead of signing now. */
  readonly queueing: Accessor<boolean>;
  readonly submit: (queueOnly: boolean) => Promise<void>;
};

export function createSubmission(input: {
  readonly source: ResponseSource;
  readonly deadline: Deadline;
  readonly rationale: Rationale;
}): Submission {
  const app = useApp();
  const { source: src, deadline, rationale } = input;

  const [submitting, setSubmitting] = createSignal(false);
  const [busyText, setBusyText] = createSignal(t("respond.submitting"));
  const [stepKey, setStepKey] = createSignal<string | null>(null);
  const [problems, setProblems] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [txHash, setTxHash] = createSignal<string | null>(null);
  const [queued, setQueued] = createSignal(false);

  // Shown only when there is more than one — a plain public submit keeps its
  // inline button state rather than raising an overlay for a single step.
  const steps = createMemo<SubmitStep[]>(() => {
    const out: SubmitStep[] = [];
    if (rationale.willPin())
      out.push({ key: "pin", label: t("respond.stepPin") });
    if (src.sealedMode())
      out.push({ key: "encrypt", label: t("respond.stepEncrypt") });
    out.push({ key: "submit", label: t("respond.stepSubmit") });
    return out;
  });

  const submit = async (queueOnly: boolean): Promise<void> => {
    const p = partsOf(src);
    if (!p) return;

    // Authoritative deadline check, against the live clock: the submit button
    // disables itself, but a click can beat the minute tick that disables it.
    if (deadline.passed(Math.floor(Date.now() / 1000))) {
      setProblems([t("respond.deadlinePassed")]);
      return;
    }

    // The pasted rationale anchor is parsed up front so a bad hash surfaces
    // alongside answer problems, before any signing. The write/pin path is
    // resolved below instead — it needs a network round-trip.
    const manual = rationale.parseManual();
    if (!manual.ok) {
      setProblems([...manual.problems]);
      return;
    }

    // Everything the submission is built from is captured at click time:
    // pinning a rationale awaits, and the progress overlay blocks the pointer
    // but not the keyboard, so reading live state afterwards could submit
    // something the validation below never saw. Draft values are replaced
    // immutably on edit, so copying the records detaches them from the store.
    const sealed = src.sealedMode();
    const draftsNow = src.drafts.map((d) => ({
      skipped: d.skipped,
      value: d.value,
    }));

    // Validate the answers as plaintext first — for a sealed survey nobody can
    // check them again until the reveal, so they must be well-formed now. The
    // rationale never affects answer validation, so it is resolved after.
    const found = validateResponse(
      { ...p.def, submissionMode: { type: "public" } },
      buildResponse(p.ref, p.role, p.credential, p.def.questions, draftsNow),
    );
    setProblems(found.map(problemText));
    if (found.length > 0) return;

    setSubmitting(true);
    setError(null);
    setStepKey(steps()[0]?.key ?? "submit");
    try {
      if (rationale.willPin()) setBusyText(t("respond.pinningRationale"));
      const anchor: ContentAnchor | undefined = await rationale.resolve(
        manual.anchor,
      );

      let response = buildResponse(
        p.ref,
        p.role,
        p.credential,
        p.def.questions,
        draftsNow,
        anchor,
      );
      if (sealed) {
        // Timelock-encrypt the answers to the survey's drand round, then submit
        // the ciphertext instead of the plaintext answers.
        setStepKey("encrypt");
        setBusyText(t("respond.encrypting"));
        // Only ~/wallet/cbor is loaded lazily — it is the import that gates
        // the heavy evolution-sdk chunk. cip-179/tlock is already statically
        // imported above (tlock-js itself stays lazy inside its client).
        const { evolutionCodec } = await import("~/wallet/cbor");
        const ciphertext = await sealAnswers(
          evolutionCodec,
          collectAnswers(p.def.questions, draftsNow),
          sealed.round,
          sealed.paddingSize,
        );
        response = buildSealedResponse(
          p.ref,
          p.role,
          p.credential,
          ciphertext,
          anchor,
        );
      }
      setStepKey("submit");
      setBusyText(t("respond.submitting"));
      // Prove control of the responder credential via required_signers (CIP-179
      // credential proof) — e.g. forces the wallet to sign with the stake key
      // when responding as a Stakeholder, not just the payment key.
      const action: Action = {
        kind: "response",
        response,
        proveCredentials: [p.credential],
        title: p.def.title || undefined,
      };
      if (queueOnly) {
        app.enqueue([action]);
        setQueued(true);
        return;
      }
      const hashes = await app.submitOrQueue([action]);
      if (hashes) setTxHash(hashes[0] ?? null);
      else setQueued(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
      setBusyText(t("respond.submitting"));
      setStepKey(null);
    }
  };

  return {
    submitting,
    busyText,
    stepKey,
    steps,
    problems,
    error,
    txHash,
    queued,
    // With something already waiting, submitting this response would publish
    // that too — so the button queues instead, and the cart is where it all
    // goes out.
    queueing: () => app.cart().length > 0,
    submit,
  };
}
