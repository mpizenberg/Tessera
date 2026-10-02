import { beforeAll, describe, expect, it } from "vitest";

import { VALIDATION_PROBLEM_CODES } from "cip-179";

import { FORM_PROBLEM_CODES } from "~/domain/create";
import { setLocale } from "~/i18n";
import { createProblemText, problemText } from "./problem";

// Force a deterministic locale — the module otherwise sniffs navigator/storage,
// which vary by machine. `en` is bundled, so this resolves synchronously.
beforeAll(async () => {
  await setLocale("en");
});

describe("problemText", () => {
  it("renders every declared cip-179 problem code from the catalog", () => {
    for (const code of VALIDATION_PROBLEM_CODES) {
      const text = problemText({ code });
      // A missing catalog entry falls through to the raw `validation.<code>`
      // key — assert we never see that, i.e. the catalog is exhaustive.
      expect(text).not.toBe(`validation.${code}`);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("renders every form problem code from the catalog", () => {
    for (const code of FORM_PROBLEM_CODES) {
      const text = createProblemText({ code, field: "budget" });
      expect(text).not.toBe(`validation.${code}`);
      expect(text.startsWith("Budget: ")).toBe(true);
    }
  });

  it("names a form problem by the question and the label of its input", () => {
    expect(
      createProblemText({
        code: "form.notWholeNumber",
        field: "maxSelections",
        question: 2,
        params: { text: "12abc" },
      }),
    ).toBe('Q3 max selections: "12abc" is not a whole number');
    expect(
      createProblemText({
        code: "form.outOfRange",
        field: "endEpoch",
        params: { text: "-5", min: "0", max: "9" },
      }),
    ).toBe("End epoch (inclusive): -5 is not between 0 and 9");
  });

  it("interpolates params into the localized template", () => {
    expect(
      problemText({
        code: "answer.optionIndexOutOfRange",
        params: { where: "answers[0]", index: 9 },
      }),
    ).toBe("answers[0]: option index 9 out of range");
  });

  it("renders paramless problems verbatim", () => {
    expect(problemText({ code: "response.sealedRequired" })).toBe(
      "sealed survey requires a sealed (ciphertext) response",
    );
  });
});
