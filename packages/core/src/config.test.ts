import { expect, test } from "vitest";

import { KOIOS_URL } from "./config";

test("pins each Koios endpoint", () => {
  expect(KOIOS_URL).toEqual({
    mainnet: "https://api.koios.rest/api/v1",
    preprod: "https://preprod.koios.rest/api/v1",
    preview: "https://preview.koios.rest/api/v1",
  });
});
