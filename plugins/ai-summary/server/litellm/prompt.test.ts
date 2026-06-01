import { parseSummaryResponse } from "./prompt";

describe("parseSummaryResponse", () => {
  it("parses a clean JSON object", () => {
    const out = parseSummaryResponse(
      JSON.stringify({ title: "A Paper", summaryMarkdown: "## Summary\nhi" })
    );
    expect(out.title).toEqual("A Paper");
    expect(out.summaryMarkdown).toContain("## Summary");
  });

  it("strips code fences before parsing", () => {
    const out = parseSummaryResponse(
      "```json\n" + JSON.stringify({ title: "X", summaryMarkdown: "body" }) + "\n```"
    );
    expect(out.title).toEqual("X");
    expect(out.summaryMarkdown).toEqual("body");
  });

  it("returns null title when missing", () => {
    const out = parseSummaryResponse(JSON.stringify({ summaryMarkdown: "body" }));
    expect(out.title).toBeNull();
    expect(out.summaryMarkdown).toEqual("body");
  });

  it("throws when summaryMarkdown is missing", () => {
    expect(() => parseSummaryResponse(JSON.stringify({ title: "X" }))).toThrow();
  });

  it("throws on empty content", () => {
    expect(() => parseSummaryResponse(undefined)).toThrow();
  });
});
