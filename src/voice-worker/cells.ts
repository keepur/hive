/** A/B cell identifiers (spec §14.1). Import-free — unit-testable without LiveKit. */
export interface VendorCell {
  stt: "deepgram/flux-general-en" | "deepgram/nova-3";
  tts: "cartesia/sonic-3" | "elevenlabs/eleven_flash_v2_5";
}

const STT_VALUES = new Set(["deepgram/flux-general-en", "deepgram/nova-3"]);
const TTS_VALUES = new Set(["cartesia/sonic-3", "elevenlabs/eleven_flash_v2_5"]);

export function resolveCell(
  meta: { stt?: string; tts?: string },
  defaults: { defaultStt: string; defaultTts: string },
): VendorCell {
  const stt = meta.stt ?? defaults.defaultStt;
  const tts = meta.tts ?? defaults.defaultTts;
  if (!STT_VALUES.has(stt)) throw new Error(`Unknown STT cell: ${stt}`);
  if (!TTS_VALUES.has(tts)) throw new Error(`Unknown TTS cell: ${tts}`);
  return { stt, tts } as VendorCell;
}
