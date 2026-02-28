import { LinearClient as LinearSDK } from "@linear/sdk";
import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";

const log = createLogger("linear-client");

export class LinearClient {
  private client: LinearSDK | null = null;

  init(): void {
    if (!config.linear.apiKey) {
      log.warn("No Linear API key configured — Linear integration disabled");
      return;
    }
    this.client = new LinearSDK({ apiKey: config.linear.apiKey });
    log.info("Linear client initialized");
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  async createIssue(title: string, description?: string, teamId?: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const issue = await this.client.createIssue({
        title,
        description,
        teamId: teamId ?? (await this.getDefaultTeamId()),
      });
      const created = await issue.issue;
      log.info("Issue created", { id: created?.identifier, title });
      return created?.identifier ?? null;
    } catch (err) {
      log.error("Failed to create issue", { error: String(err) });
      return null;
    }
  }

  async getIssue(issueId: string): Promise<{ title: string; state: string; assignee: string | null } | null> {
    if (!this.client) return null;
    try {
      const issue = await this.client.issue(issueId);
      const state = await issue.state;
      const assignee = await issue.assignee;
      return {
        title: issue.title,
        state: state?.name ?? "Unknown",
        assignee: assignee?.name ?? null,
      };
    } catch (err) {
      log.error("Failed to get issue", { issueId, error: String(err) });
      return null;
    }
  }

  async getMyIssues(limit = 10): Promise<Array<{ id: string; title: string; state: string }>> {
    if (!this.client) return [];
    try {
      const me = await this.client.viewer;
      const issues = await me.assignedIssues({ first: limit });
      const results = [];
      for (const issue of issues.nodes) {
        const state = await issue.state;
        results.push({
          id: issue.identifier,
          title: issue.title,
          state: state?.name ?? "Unknown",
        });
      }
      return results;
    } catch (err) {
      log.error("Failed to list issues", { error: String(err) });
      return [];
    }
  }

  private async getDefaultTeamId(): Promise<string> {
    if (!this.client) throw new Error("Linear not configured");
    const teams = await this.client.teams({ first: 1 });
    const team = teams.nodes[0];
    if (!team) throw new Error("No Linear teams found");
    return team.id;
  }
}
