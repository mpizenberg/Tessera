/** Shared validation/error callouts (Create & Respond screens). */

const feedback = {
  /** Default heading for an error box when the caller passes no title. */
  submissionFailed: "Submission failed",
};

export type Messages = typeof feedback;
export default feedback;
