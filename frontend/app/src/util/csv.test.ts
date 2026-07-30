import { describe, expect, it } from "vitest";

import { toCsv } from "./csv";

describe("toCsv", () => {
  it("joins cells with commas and rows with CRLF", () => {
    expect(toCsv([["a", "b"], ["c"]])).toBe("a,b\r\nc");
  });

  it("quotes cells containing a comma, quote or newline", () => {
    expect(toCsv([["a,b", 'say "hi"', "two\nlines"]])).toBe(
      '"a,b","say ""hi""","two\nlines"',
    );
  });

  it("leaves ordinary cells unquoted", () => {
    expect(toCsv([["plain", "42", "yes/no"]])).toBe("plain,42,yes/no");
  });

  it("neutralizes formula leads with an apostrophe", () => {
    expect(toCsv([["=1+1", "+x", "@SUM(A1)", "-cmd"]])).toBe(
      "'=1+1,'+x,'@SUM(A1),'-cmd",
    );
  });

  it("neutralizes the tab and CR leads spreadsheets also treat as formulas", () => {
    expect(toCsv([["\t=1+1"]])).toBe("'\t=1+1");
    expect(toCsv([["\r=1+1"]])).toBe('"\'\r=1+1"');
  });

  it("prefixes inside the quotes when the cell also needs quoting", () => {
    expect(toCsv([['=HYPERLINK("http://evil","x")']])).toBe(
      '"\'=HYPERLINK(""http://evil"",""x"")"',
    );
  });

  it("prefixes legitimate negative numbers too (accepted cost)", () => {
    expect(toCsv([["-3"]])).toBe("'-3");
  });

  it("only looks at the first character", () => {
    expect(toCsv([["a=1", "1-2"]])).toBe("a=1,1-2");
  });
});
