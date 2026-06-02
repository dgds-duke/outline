import { parseSummary, shortenTitle } from "./prompt";

const SAMPLE = `Title: Ammonia dynamics in recirculating aquaculture systems
DOI: 10.1234/aqua.2021.0045

## Overview
Some overview text.

## Key findings
- **Higher yield**: it went up by 20%.

---

**Citation**
> Smith, J. & Doe, A. (2021). *Ammonia dynamics in recirculating aquaculture systems*. Aquaculture, 12(3), 45-60. DOI: 10.1234/aqua.2021.0045
`;

describe("parseSummary", () => {
  it("reads the title from the header", () => {
    expect(parseSummary(SAMPLE).title).toEqual(
      "Ammonia dynamics in recirculating aquaculture systems"
    );
  });

  it("reads the DOI from the header, not the citation line", () => {
    expect(parseSummary(SAMPLE).doi).toEqual("10.1234/aqua.2021.0045");
  });

  it("returns a body that starts at the first heading and omits the header", () => {
    const { body } = parseSummary(SAMPLE);
    expect(body.startsWith("## Overview")).toBe(true);
    expect(body).not.toMatch(/^Title:/m);
    expect(body).toContain("**Citation**");
  });

  it("treats DOI: none as null", () => {
    expect(
      parseSummary(SAMPLE.replace("10.1234/aqua.2021.0045", "none")).doi
    ).toBeNull();
  });

  it("normalizes a doi.org URL in the header to the bare DOI", () => {
    const md = SAMPLE.replace(
      "DOI: 10.1234/aqua.2021.0045",
      "DOI: https://doi.org/10.1234/aqua.2021.0045"
    );
    expect(parseSummary(md).doi).toEqual("10.1234/aqua.2021.0045");
  });

  it("falls back to the first heading text when the Title header is missing", () => {
    const md = "## A study of widgets\nbody text";
    expect(parseSummary(md).title).toEqual("A study of widgets");
  });

  it("demotes a leading H1 in the body to H2 (Outline stores the title separately)", () => {
    const md = "Title: T\nDOI: none\n\n# Big heading\nbody";
    expect(parseSummary(md).body.startsWith("## Big heading")).toBe(true);
  });
});

describe("shortenTitle", () => {
  it("leaves short titles unchanged", () => {
    expect(shortenTitle("Short title")).toEqual("Short title");
  });

  it("truncates long titles at a word boundary with an ellipsis under the limit", () => {
    const long = "A ".repeat(80) + "end";
    const out = shortenTitle(long);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/ $/);
  });
});
