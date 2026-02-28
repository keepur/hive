import { exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logging/logger.js";

const execAsync = promisify(exec);
const log = createLogger("memory-manager");

export class MemoryManager {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  async init(): Promise<void> {
    try {
      await this.git("status --short");
      log.info("Memory repo ready", { path: this.repoPath });
    } catch {
      log.error("Memory repo not found or not a git repo", { path: this.repoPath });
      throw new Error(`Memory repo not available at ${this.repoPath}`);
    }
  }

  async read(relativePath: string): Promise<string | null> {
    try {
      const fullPath = join(this.repoPath, relativePath);
      return await readFile(fullPath, "utf-8");
    } catch {
      return null;
    }
  }

  async write(relativePath: string, content: string): Promise<void> {
    const fullPath = join(this.repoPath, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  async commitAndPush(message: string): Promise<void> {
    try {
      await this.git("add -A");

      // Check if there are changes to commit
      const { stdout } = await this.git("status --porcelain");
      if (!stdout.trim()) {
        log.debug("No changes to commit");
        return;
      }

      await this.git(`commit -m "${message.replace(/"/g, '\\"')}"`);
      await this.git("push");
      log.info("Memory committed and pushed", { message });
    } catch (err) {
      log.error("Failed to commit/push memory", { error: String(err) });
    }
  }

  async pull(): Promise<void> {
    try {
      await this.git("pull --rebase");
    } catch (err) {
      log.warn("Failed to pull memory repo", { error: String(err) });
    }
  }

  private async git(command: string): Promise<{ stdout: string; stderr: string }> {
    return execAsync(`git -C "${this.repoPath}" ${command}`);
  }
}
