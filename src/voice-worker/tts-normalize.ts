/** Light TTS text normalization — strip markdown residue (KPR-322 §5.1). Import-free. */
export function normalizeForTTS(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1") // [label](url) → label
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2") // emphasis
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // inline/backtick code
    .replace(/^#{1,6}\s+/gm, ""); // headings
}
