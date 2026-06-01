import { reciprocalRankFusion } from "./fusion";

describe("reciprocalRankFusion", () => {
  it("ranks a doc appearing high in both lists first", () => {
    const lexical = ["a", "b", "c"];
    const vector = ["c", "a", "d"];
    const fused = reciprocalRankFusion([lexical, vector]);
    expect(fused[0]).toEqual("a"); // top-of-both beats top-of-one
    expect(fused).toContain("d");
    expect(new Set(fused).size).toEqual(fused.length); // deduped
  });

  it("preserves single-list order", () => {
    expect(reciprocalRankFusion([["x", "y", "z"]])).toEqual(["x", "y", "z"]);
  });

  it("returns empty for empty input", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});
