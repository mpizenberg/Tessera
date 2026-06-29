/** Multi-step submission overlay (pin → encrypt → sign & submit). */

const submitProgress = {
  /**
   * Screen-reader announcement of the current step. {current}/{total} are
   * locale-formatted positions and {label} is the (caller-provided) step name.
   */
  srStep: "Step {current} of {total}: {label}",
  approveNote:
    "Approve the transaction in your wallet when prompted — don't close this tab.",
};

export type Messages = typeof submitProgress;
export default submitProgress;
