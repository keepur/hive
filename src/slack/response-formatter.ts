const MAX_SLACK_MESSAGE_LENGTH = 3000;

/**
 * Convert standard Markdown to Slack mrkdwn format.
 * Slack uses *bold* not **bold**, no # headers, <url|text> not [text](url), etc.
 */
export function markdownToMrkdwn(text: string): string {
  let out = text;
  // Headers → bold (Slack has no header syntax)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  // Bold+italic ***text*** → *_text_*
  out = out.replace(/\*{3}(.+?)\*{3}/g, "*_$1_*");
  // Bold **text** → *text*
  out = out.replace(/\*{2}(.+?)\*{2}/g, "*$1*");
  // Bold __text__ → *text*
  out = out.replace(/__(.+?)__/g, "*$1*");
  // Links [text](url) → <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  // Strikethrough ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, "~$1~");
  // Horizontal rules → em dash line
  out = out.replace(/^[-*_]{3,}$/gm, "———");
  return out;
}

export function formatResponse(text: string): string {
  if (!text) return "_No response._";

  // Convert markdown to Slack mrkdwn
  let formatted = markdownToMrkdwn(text.trim());

  // Truncate if too long for a single Slack message
  if (formatted.length > MAX_SLACK_MESSAGE_LENGTH) {
    formatted = formatted.slice(0, MAX_SLACK_MESSAGE_LENGTH - 20) + "\n\n_...truncated_";
  }

  return formatted;
}

export function formatError(error: string): string {
  return `Something went wrong: ${error}`;
}

export function formatStatus(agentId: string, status: string, details?: Record<string, unknown>): string {
  const lines = [`*${agentId}*: ${status}`];
  if (details) {
    for (const [key, val] of Object.entries(details)) {
      lines.push(`  ${key}: ${val}`);
    }
  }
  return lines.join("\n");
}
