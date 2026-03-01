import { LinearClient as LinearSdkClient } from "@linear/sdk";
import { createLogger } from "../logging/logger.js";

const log = createLogger("linear-client");

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface IssueResult {
  identifier: string; // e.g. "HIVE-42"
  id: string; // UUID
  url: string; // Linear web URL
}

export interface CreateIssueOpts {
  description?: string;
  priority?: number; // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  stateId?: string;
  labelIds?: string[];
  teamId?: string; // override default team
}

export interface UpdateIssueFields {
  title?: string;
  description?: string;
  stateId?: string;
  priority?: number;
}

export interface ListIssuesOpts {
  stateType?: string;
  limit?: number;
  teamId?: string;
}

export interface IssueSummary {
  identifier: string;
  id: string;
  title: string;
  state: string;
  priority: number;
  url: string;
}

export interface IssueDetail extends IssueSummary {
  description?: string;
}

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface TeamInfo {
  id: string;
  name: string;
  key: string;
}

// ── Client ──────────────────────────────────────────────────────────────────

export class LinearClient {
  private client: LinearSdkClient;
  private defaultTeamId?: string;

  constructor(apiKey: string, defaultTeamId?: string) {
    this.client = new LinearSdkClient({ apiKey });
    this.defaultTeamId = defaultTeamId;
  }

  async listTeams(): Promise<TeamInfo[]> {
    try {
      const result = await this.client.teams();
      return result.nodes.map((t) => ({
        id: t.id,
        name: t.name,
        key: t.key,
      }));
    } catch (err) {
      log.error("Failed to list teams", { error: String(err) });
      return [];
    }
  }

  async createIssue(
    title: string,
    opts?: CreateIssueOpts,
  ): Promise<IssueResult | null> {
    try {
      const teamId = opts?.teamId ?? this.defaultTeamId;
      if (!teamId) {
        log.error("Cannot create issue: no teamId provided and no default set");
        return null;
      }
      const result = await this.client.createIssue({
        teamId,
        title,
        description: opts?.description,
        priority: opts?.priority,
        stateId: opts?.stateId,
        labelIds: opts?.labelIds,
      });
      const issue = await result.issue;
      if (!issue) {
        log.error("Issue creation returned no issue", { title });
        return null;
      }
      log.info("Issue created", { identifier: issue.identifier, title });
      return {
        identifier: issue.identifier,
        id: issue.id,
        url: issue.url,
      };
    } catch (err) {
      log.error("Failed to create issue", { error: String(err), title });
      return null;
    }
  }

  async updateIssue(
    issueId: string,
    fields: UpdateIssueFields,
  ): Promise<boolean> {
    try {
      await this.client.updateIssue(issueId, fields);
      log.info("Issue updated", { issueId, ...fields });
      return true;
    } catch (err) {
      log.error("Failed to update issue", { error: String(err), issueId });
      return false;
    }
  }

  async addComment(issueId: string, body: string): Promise<string | null> {
    try {
      const result = await this.client.createComment({ issueId, body });
      const comment = await result.comment;
      log.info("Comment added", { issueId, commentId: comment?.id });
      return comment?.id ?? null;
    } catch (err) {
      log.error("Failed to add comment", { error: String(err), issueId });
      return null;
    }
  }

  async listIssues(opts?: ListIssuesOpts): Promise<IssueSummary[]> {
    try {
      const teamId = opts?.teamId ?? this.defaultTeamId;
      const filter: Record<string, unknown> = {};
      if (teamId) {
        filter.team = { id: { eq: teamId } };
      }
      if (opts?.stateType) {
        filter.state = { type: { eq: opts.stateType } };
      }
      const result = await this.client.issues({
        filter,
        first: opts?.limit ?? 50,
        orderBy: "updatedAt" as any,
      });
      const summaries: IssueSummary[] = [];
      for (const issue of result.nodes) {
        const state = await issue.state;
        summaries.push({
          identifier: issue.identifier,
          id: issue.id,
          title: issue.title,
          state: state?.name ?? "Unknown",
          priority: issue.priority,
          url: issue.url,
        });
      }
      return summaries;
    } catch (err) {
      log.error("Failed to list issues", { error: String(err) });
      return [];
    }
  }

  async searchIssues(
    term: string,
    limit?: number,
    teamId?: string,
  ): Promise<IssueSummary[]> {
    try {
      const resolvedTeamId = teamId ?? this.defaultTeamId;
      const result = await this.client.searchIssues(term, {
        first: limit ?? 10,
      });
      const nodes = result.nodes;
      const summaries: IssueSummary[] = [];
      for (const issue of nodes) {
        // Post-filter by team if teamId is set (search API doesn't accept team filter)
        if (resolvedTeamId) {
          const issueTeam = await issue.team;
          if (issueTeam?.id !== resolvedTeamId) continue;
        }
        const state = await issue.state;
        summaries.push({
          identifier: issue.identifier,
          id: issue.id,
          title: issue.title,
          state: state?.name ?? "Unknown",
          priority: issue.priority,
          url: issue.url,
        });
      }
      return summaries;
    } catch (err) {
      log.error("Failed to search issues", { error: String(err), term });
      return [];
    }
  }

  async getWorkflowStates(teamId?: string): Promise<WorkflowState[]> {
    try {
      const resolvedTeamId = teamId ?? this.defaultTeamId;
      const filter: Record<string, unknown> = {};
      if (resolvedTeamId) {
        filter.team = { id: { eq: resolvedTeamId } };
      }
      const result = await this.client.workflowStates({ filter });
      return result.nodes.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
      }));
    } catch (err) {
      log.error("Failed to get workflow states", { error: String(err) });
      return [];
    }
  }

  async findIssueByIdentifier(
    identifier: string,
  ): Promise<IssueDetail | null> {
    try {
      const issue = await this.client.issue(identifier);
      const state = await issue.state;
      return {
        identifier: issue.identifier,
        id: issue.id,
        title: issue.title,
        state: state?.name ?? "Unknown",
        priority: issue.priority,
        url: issue.url,
        description: issue.description ?? undefined,
      };
    } catch (err) {
      log.error("Failed to find issue", { error: String(err), identifier });
      return null;
    }
  }
}
