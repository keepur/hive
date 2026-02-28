const MAX_SLACK_MESSAGE_LENGTH = 3000;

export function formatResponse(text: string): string {
  if (!text) return "_No response._";

  // Trim whitespace
  let formatted = text.trim();

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
