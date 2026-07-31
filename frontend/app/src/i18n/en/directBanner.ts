const directBanner = {
  // Prose split around the inline-bold lead (Strong/strong · Rest/rest).
  emergencyStrong: "Emergency direct mode.",
  /** {time} is a local wall-clock datetime, e.g. "Jul 31, 2026, 14:05". */
  emergencyRest:
    "This browser is reading the chain via Koios, without the Tessera backend. Responses are unverified — credential proofs and voting weights are only checked at finalization. The backend resumes {time}.",
  strong: "Direct Koios mode.",
  rest: "Responses are unverified — credential proofs and voting weights are only checked at finalization. Run the independent verifier to audit results.",
};

export type Messages = typeof directBanner;
export default directBanner;
