import { describe, expect, it } from "vitest";
import { normalizeForTTS } from "./tts-normalize.js";

describe("normalizeForTTS (KPR-322)", () => {
  it("strips markdown links to the label", () => {
    expect(normalizeForTTS("see [docs](https://example.com) please")).toBe("see docs please");
  });

  it("strips bold and emphasis markers", () => {
    expect(normalizeForTTS("**bold** and __also__ plus *em* and _em2_")).toBe("bold and also plus em and em2");
  });

  it("strips inline and fenced backticks", () => {
    expect(normalizeForTTS("use `code` and ```block```")).toBe("use code and block");
  });

  it("strips heading hashes", () => {
    expect(normalizeForTTS("# Title\n## Sub")).toBe("Title\nSub");
  });
});
