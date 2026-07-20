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

export interface LabelInfo {
  id: string;
  name: string;
  color: string;
  isGroup: boolean;
  description?: string;
}

export interface CreateLabelOpts {
  teamId?: string;
  color?: string;
  description?: string;
}

export interface ListIssuesOpts {
  stateType?: string;
  limit?: number;
  teamId?: string;
  assigneeEmail?: string;
}

export interface AssigneeInfo {
  id: string;
  name: string;
  email: string;
}

export interface IssueSummary {
  identifier: string;
  id: string;
  title: string;
  state: string;
  priority: number;
  url: string;
  assignee?: AssigneeInfo;
}

export interface IssueDetail extends IssueSummary {
  description?: string;
  labels: string[];
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

export interface UserInfo {
  id: string;
  name: string;
  displayName: string;
  email: string;
  active: boolean;
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

  async createIssue(title: string, opts?: CreateIssueOpts): Promise<IssueResult | null> {
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

  async updateIssue(issueId: string, fields: UpdateIssueFields): Promise<boolean> {
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
      if (opts?.assigneeEmail) {
        filter.assignee = { email: { eq: opts.assigneeEmail } };
      }
      const result = await this.client.issues({
        filter,
        first: opts?.limit ?? 50,
        orderBy: "updatedAt" as any,
      });
      const summaries: IssueSummary[] = [];
      for (const issue of result.nodes) {
        const state = await issue.state;
        const assignee = await issue.assignee;
        summaries.push({
          identifier: issue.identifier,
          id: issue.id,
          title: issue.title,
          state: state?.name ?? "Unknown",
          priority: issue.priority,
          url: issue.url,
          assignee: assignee ? { id: assignee.id, name: assignee.name, email: assignee.email } : undefined,
        });
      }
      return summaries;
    } catch (err) {
      log.error("Failed to list issues", { error: String(err) });
      return [];
    }
  }

  async searchIssues(term: string, limit?: number, teamId?: string): Promise<IssueSummary[]> {
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
        const assignee = await issue.assignee;
        summaries.push({
          identifier: issue.identifier,
          id: issue.id,
          title: issue.title,
          state: state?.name ?? "Unknown",
          priority: issue.priority,
          url: issue.url,
          assignee: assignee ? { id: assignee.id, name: assignee.name, email: assignee.email } : undefined,
        });
      }
      return summaries;
    } catch (err) {
      log.error("Failed to search issues", { error: String(err), term });
      return [];
    }
  }

  async listLabels(teamId?: string): Promise<LabelInfo[]> {
    try {
      const resolvedTeamId = teamId ?? this.defaultTeamId;
      // Team labels plus workspace-level labels (team is null on those)
      const filter = resolvedTeamId
        ? { or: [{ team: { id: { eq: resolvedTeamId } } }, { team: { null: true } }] }
        : undefined;
      const result = await this.client.issueLabels({ filter, first: 250 });
      return result.nodes.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
        isGroup: l.isGroup,
        description: l.description ?? undefined,
      }));
    } catch (err) {
      log.error("Failed to list labels", { error: String(err) });
      return [];
    }
  }

  async createLabel(name: string, opts?: CreateLabelOpts): Promise<LabelInfo | null> {
    try {
      const teamId = opts?.teamId ?? this.defaultTeamId;
      const result = await this.client.createIssueLabel({
        teamId,
        name,
        color: opts?.color,
        description: opts?.description,
      });
      const label = await result.issueLabel;
      if (!label) {
        log.error("Label creation returned no label", { name });
        return null;
      }
      log.info("Label created", { name, labelId: label.id });
      return { id: label.id, name: label.name, color: label.color, isGroup: label.isGroup };
    } catch (err) {
      log.error("Failed to create label", { error: String(err), name });
      return null;
    }
  }

  async addLabelToIssue(issueId: string, labelId: string): Promise<boolean> {
    try {
      await this.client.issueAddLabel(issueId, labelId);
      log.info("Label added to issue", { issueId, labelId });
      return true;
    } catch (err) {
      log.error("Failed to add label to issue", { error: String(err), issueId, labelId });
      return false;
    }
  }

  async removeLabelFromIssue(issueId: string, labelId: string): Promise<boolean> {
    try {
      await this.client.issueRemoveLabel(issueId, labelId);
      log.info("Label removed from issue", { issueId, labelId });
      return true;
    } catch (err) {
      log.error("Failed to remove label from issue", { error: String(err), issueId, labelId });
      return false;
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

  async searchUsers(query: string, limit?: number): Promise<UserInfo[]> {
    try {
      const result = await this.client.users({
        filter: {
          or: [
            { name: { containsIgnoreCase: query } } as any,
            { displayName: { containsIgnoreCase: query } } as any,
            { email: { containsIgnoreCase: query } } as any,
          ],
        },
        first: limit ?? 10,
      });
      return result.nodes.map((u) => ({
        id: u.id,
        name: u.name,
        displayName: u.displayName,
        email: u.email,
        active: u.active,
      }));
    } catch (err) {
      log.error("Failed to search users", { error: String(err), query });
      return [];
    }
  }

  async findIssueByIdentifier(identifier: string): Promise<IssueDetail | null> {
    try {
      const issue = await this.client.issue(identifier);
      const state = await issue.state;
      const assignee = await issue.assignee;
      const labels = await issue.labels();
      return {
        identifier: issue.identifier,
        id: issue.id,
        title: issue.title,
        state: state?.name ?? "Unknown",
        priority: issue.priority,
        url: issue.url,
        description: issue.description ?? undefined,
        assignee: assignee ? { id: assignee.id, name: assignee.name, email: assignee.email } : undefined,
        labels: labels.nodes.map((l) => l.name),
      };
    } catch (err) {
      log.error("Failed to find issue", { error: String(err), identifier });
      return null;
    }
  }
}
