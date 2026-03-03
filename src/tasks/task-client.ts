import { createLogger } from "../logging/logger.js";

const log = createLogger("task-client");

export class TaskClient {
  private apiUrl: string;
  private apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  private async api(method: string, path: string, body?: object): Promise<any> {
    const res = await fetch(`${this.apiUrl}/api${path}`, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`Task API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async createTask(input: {
    name: string;
    description?: string;
    type?: string;
    priority?: number;
    jobIds?: string[];
  }): Promise<{ _id: string } | null> {
    try {
      const result = await this.api("POST", "/tasks", input);
      log.info("Task created", { taskId: result._id, name: input.name });
      return result;
    } catch (err) {
      log.error("Failed to create task", { error: String(err), name: input.name });
      return null;
    }
  }

  async updateTask(taskId: string, input: {
    state?: string;
    description?: string;
    priority?: number;
  }): Promise<boolean> {
    try {
      await this.api("PUT", `/tasks/${taskId}`, input);
      log.info("Task updated", { taskId, ...input });
      return true;
    } catch (err) {
      log.error("Failed to update task", { error: String(err), taskId });
      return false;
    }
  }

  async addComment(taskId: string, body: string): Promise<boolean> {
    try {
      await this.api("POST", `/tasks/${taskId}/comments`, { body });
      log.info("Comment added", { taskId });
      return true;
    } catch (err) {
      log.error("Failed to add comment", { error: String(err), taskId });
      return false;
    }
  }
}
