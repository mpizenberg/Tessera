import { afterEach, describe, expect, it, vi } from "vitest";

import { createI18n, type MsgKey } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("t — lookup, fallback, interpolation", () => {
  it("looks up a bundled string for the locale", () => {
    expect(createI18n({ locale: "en" }).t("respond.skip")).toBe("Skip");
    expect(createI18n({ locale: "fr" }).t("respond.skip")).toBe("Ignorer");
  });

  it("resolves the base language of a regional locale", () => {
    expect(createI18n({ locale: "fr-CA" }).t("respond.skip")).toBe("Ignorer");
  });

  it("falls back to English strings for an unshipped locale", () => {
    expect(createI18n({ locale: "de" }).t("respond.skip")).toBe("Skip");
  });

  it("falls back to the raw key when a message is absent", () => {
    expect(createI18n({}).t("respond.nope" as MsgKey)).toBe("respond.nope");
  });

  it("interpolates {token} params", () => {
    expect(
      createI18n({ locale: "en" }).t("respond.decidedCount", {
        decided: 1,
        total: 3,
      }),
    ).toBe("1 of 3 decided");
    expect(
      createI18n({ locale: "fr" }).t("respond.decidedCount", {
        decided: 1,
        total: 3,
      }),
    ).toBe("1 sur 3 renseignées");
  });

  it("leaves an unmatched placeholder verbatim", () => {
    expect(createI18n({}).t("respond.alreadyResponded", {})).toBe(
      "You already responded as {role}",
    );
  });
});

describe("messages override (deep-merge)", () => {
  it("overrides a single leaf, leaving siblings intact", () => {
    const i18n = createI18n({
      locale: "en",
      messages: { roles: { drep: "Custom DRep copy" } },
    });
    expect(i18n.t("roles.drep")).toBe("Custom DRep copy");
    expect(i18n.t("roles.spo")).toBe(
      "A stake pool operator — proven with cold/hot pool keys a browser wallet can't hold.",
    );
  });

  it("supplies strings for an unshipped locale", () => {
    const i18n = createI18n({
      locale: "es",
      messages: { respond: { skip: "Omitir" } },
    });
    expect(i18n.t("respond.skip")).toBe("Omitir");
    // Unsupplied keys still fall back to English.
    expect(i18n.t("respond.required")).toBe("Required");
  });
});

describe("n — locale-aware number formatting", () => {
  it("groups digits per locale", () => {
    expect(createI18n({ locale: "en" }).n(1234)).toBe("1,234");
    // French groups with a space, not a comma — assert it differs, not the
    // exact separator char (which varies by ICU version).
    expect(createI18n({ locale: "fr" }).n(1234)).not.toBe("1,234");
  });

  it("formats numbers by locale even when strings fall back to English", () => {
    // Unshipped locale: strings are English, numbers still follow the locale.
    const i18n = createI18n({
      locale: "de",
      messages: { roles: { drep: "x" } },
    });
    expect(i18n.n(1234)).toBe("1.234");
  });

  it("honours number options", () => {
    expect(createI18n({ locale: "en" }).n(0.5, { style: "percent" })).toBe(
      "50%",
    );
  });
});

describe("d — locale-aware date formatting from unix seconds", () => {
  it("formats the month name per locale (unix 0 = 1970-01-01Z)", () => {
    const opts: Intl.DateTimeFormatOptions = {
      timeZone: "UTC",
      month: "long",
    };
    expect(createI18n({ locale: "en" }).d(0, opts)).toBe("January");
    expect(createI18n({ locale: "fr" }).d(0, opts)).toBe("janvier");
  });

  it("treats its input as seconds, not milliseconds", () => {
    // One hour after the epoch.
    expect(
      createI18n({ locale: "en" }).d(3600, {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    ).toBe("01:00");
  });
});

describe("missing-catalog dev warning (option 1 + 3)", () => {
  it("warns once for an unshipped locale with no messages", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createI18n({ locale: "zz-warn-once" });
    createI18n({ locale: "zz-warn-once" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("zz-warn-once");
  });

  it("does not warn when messages are supplied", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createI18n({
      locale: "qq-with-messages",
      messages: { roles: { drep: "x" } },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn for a bundled locale", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createI18n({ locale: "en" });
    createI18n({ locale: "fr-CA" });
    expect(warn).not.toHaveBeenCalled();
  });
});
