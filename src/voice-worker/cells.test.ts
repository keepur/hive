import { describe, expect, it } from "vitest";
import { resolveCell } from "./cells.js";

const defaults = {
  defaultStt: "deepgram/flux-general-en",
  defaultTts: "cartesia/sonic-3",
};

describe("resolveCell (KPR-322)", () => {
  it("resolves all four A/B cells via metadata override", () => {
    const stts = ["deepgram/flux-general-en", "deepgram/nova-3"] as const;
    const ttss = ["cartesia/sonic-3", "elevenlabs/eleven_flash_v2_5"] as const;
    for (const stt of stts) {
      for (const tts of ttss) {
        expect(resolveCell({ stt, tts }, defaults)).toEqual({ stt, tts });
      }
    }
  });

  it("applies defaults when metadata is absent", () => {
    expect(resolveCell({}, defaults)).toEqual({
      stt: "deepgram/flux-general-en",
      tts: "cartesia/sonic-3",
    });
  });

  it("throws on unknown stt", () => {
    expect(() => resolveCell({ stt: "deepgram/unknown" }, defaults)).toThrow(/Unknown STT cell/);
  });

  it("throws on unknown tts", () => {
    expect(() => resolveCell({ tts: "cartesia/unknown" }, defaults)).toThrow(/Unknown TTS cell/);
  });
});
