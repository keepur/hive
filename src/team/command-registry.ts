// src/team/command-registry.ts

import { createLogger } from "../logging/logger.js";
import type { TeamCommandHandler, TeamCommandDef, CommandContext } from "./types.js";
import type { TeamStore } from "./team-store.js";

const log = createLogger("command-registry");

export class CommandRegistry {
  private commands = new Map<string, TeamCommandHandler>();

  constructor(private teamStore: TeamStore) {
    this.registerCoreCommands();
  }

  register(handler: TeamCommandHandler): void {
    if (this.commands.has(handler.def.name)) {
      log.warn("Command already registered, overwriting", { name: handler.def.name });
    }
    this.commands.set(handler.def.name, handler);
    log.info("Command registered", { name: handler.def.name, source: handler.def.source });
  }

  get(name: string): TeamCommandHandler | undefined {
    return this.commands.get(name);
  }

  list(): TeamCommandDef[] {
    return [...this.commands.values()].map((h) => h.def);
  }

  async execute(name: string, context: CommandContext): Promise<{ found: boolean; result?: string }> {
    const handler = this.commands.get(name);
    if (!handler) return { found: false };

    try {
      const result = await handler.execute(context);
      return { found: true, result };
    } catch (err) {
      log.error("Command execution failed", { name, error: String(err) });
      return { found: true, result: `Command failed: ${String(err)}` };
    }
  }

  private registerCoreCommands(): void {
    this.register({
      def: {
        name: "help",
        source: "core",
        description: "List available commands",
      },
      execute: async () => {
        const defs = this.list();
        const lines = defs.map((d) => `  /${d.name} — ${d.description}`);
        return `Available commands:\n${lines.join("\n")}`;
      },
    });

    this.register({
      def: {
        name: "new",
        source: "core",
        description: "Create a new DM with an agent",
        args: [{ name: "agent", required: true, description: "Agent ID to start a DM with" }],
      },
      execute: async (ctx) => {
        const targetAgent = ctx.args[0];
        if (!targetAgent) return "Usage: /new <agent-id>";
        const dm = await this.teamStore.getOrCreateDm(ctx.senderId, targetAgent, ctx.senderName);
        return `DM ready: ${dm._id}`;
      },
    });

    this.register({
      def: {
        name: "rename",
        source: "core",
        description: "Rename the current channel or thread",
        args: [{ name: "name", required: true, description: "New name" }],
      },
      execute: async (ctx) => {
        const newName = ctx.args.join(" ");
        if (!newName) return "Usage: /rename <new name>";
        const ok = await this.teamStore.renameChannel(ctx.channelId, newName);
        return ok ? `Renamed to "${newName}"` : "Channel not found";
      },
    });

    this.register({
      def: {
        name: "members",
        source: "core",
        description: "List members of the current channel",
      },
      execute: async (ctx) => {
        const channel = await this.teamStore.getChannel(ctx.channelId);
        if (!channel) return "Channel not found";
        return `Members of ${channel.name}:\n${channel.members.map((m) => `  - ${m}`).join("\n")}`;
      },
    });
  }
}
