import { beforeAll, describe, expect, it } from "vitest";

import { VALIDATION_PROBLEM_CODES } from "cip-179";

import { setLocale } from "~/i18n";
import { problemText } from "./problem";

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
