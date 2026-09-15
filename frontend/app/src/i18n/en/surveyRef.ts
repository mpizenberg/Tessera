/** A survey's on-chain reference, shown with a copy button. */

const surveyRef = {
  title:
    "Survey ref: the transaction that defines the survey, and the survey's position in it",
  /** {ref} is the raw "<txHash>:<index>" key, shown untranslated. */
  label: "ref {ref}",
};

export type Messages = typeof surveyRef;
export default surveyRef;
