import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import type { SweepResult } from "../sweeper/sweeper.js";

const log = createLogger("meeting-monitor");

const POLL_INTERVAL_MS = 10_000;
const BATCH_WINDOW_MS = 15_000;
const IDLE_FLUSH_POLLS = 2;
const TERMINAL_STATUSES = new Set(["done", "fatal", "call_ended", "media_expired", "recording_permission_denied"]);

export interface MeetingMonitorContext {
  agentId: string;
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  threadId: string;
  slackTs: string;
  slackThreadTs: string;
}

interface MeetingSession {
  id: string;
  botId: string;
  botName: string;
  meetingUrl: string;
  apiKey: string;
  region: string;
  context: MeetingMonitorContext;
  lastSegmentIndex: number;
  pendingSegments: { speaker: string; text: string }[];
  activePartials: Map<number, { speaker: string; text: string }>; // keyed by participant ID
  lastDispatchTime: number;
  idlePollCount: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  pollCount: number;
  status: "monitoring" | "ended" | "error";
  endedAt: number | null;
}

export class MeetingMonitor {
  private port: number;
  private onUpdate: (item: WorkItem) => void;
  private server: Server | null = null;
  private sessions = new Map<string, MeetingSession>();
  private sessionsByBotId = new Map<string, string>();

  constructor(port: number, onUpdate: (item: WorkItem) => void) {
    this.port = port;
    this.onUpdate = onUpdate;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error("HTTP handler error", { error: String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, "127.0.0.1", () => resolve());
    });

    log.info("Meeting monitor started", { port: this.port });
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      if (session.pollTimer) {
        clearInterval(session.pollTimer);
        session.pollTimer = null;
      }
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    log.info("Meeting monitor stopped");
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    // POST /meetings/start — start monitoring a meeting
    if (req.method === "POST" && url.pathname === "/meetings/start") {
      const body = await this.readBody(req);
      const parsed = JSON.parse(body);

      const session = this.createSession(parsed);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessionId: session.id }));
      return;
    }

    // POST /meetings/{id}/stop — stop monitoring a session
    const stopMatch = url.pathname.match(/^\/meetings\/([a-f0-9-]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      const id = stopMatch[1];
      const session = this.sessions.get(id);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      if (session.pollTimer) {
        clearInterval(session.pollTimer);
        session.pollTimer = null;
      }
      session.status = "ended";
      session.endedAt = Date.now();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "stopped" }));
      return;
    }

    // POST /webhook/transcript — receive real-time transcript from Recall
    if (req.method === "POST" && url.pathname === "/webhook/transcript") {
      const body = await this.readBody(req);
      this.handleTranscriptWebhook(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /meetings — list active sessions
    if (req.method === "GET" && url.pathname === "/meetings") {
      const list: Array<Record<string, unknown>> = [];

      for (const session of this.sessions.values()) {
        list.push({
          id: session.id,
          botId: session.botId,
          botName: session.botName,
          meetingUrl: session.meetingUrl,
          status: session.status,
          pollCount: session.pollCount,
          lastSegmentIndex: session.lastSegmentIndex,
          pendingSegments: session.pendingSegments.length,
        });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private handleTranscriptWebhook(raw: string): void {
    try {
      const payload = JSON.parse(raw);
      const event = payload.event;
      const botId = payload.data?.bot?.id;

      if (!botId) {
        log.warn("Webhook missing bot ID", { event });
        return;
      }

      const sessionId = this.sessionsByBotId.get(botId);
      if (!sessionId) {
        log.warn("Webhook for unknown bot", { botId, event });
        return;
      }

      const session = this.sessions.get(sessionId);
      if (!session || session.status !== "monitoring") return;

      const data = payload.data?.data;
      if (!data) return;

      const participantId = data.participant?.id ?? 0;
      const speaker = data.participant?.name ?? "Unknown";
      const words = Array.isArray(data.words)
        ? data.words.map((w: any) => w.text).join(" ")
        : "";

      if (!words) return;

      session.idlePollCount = 0;

      if (event === "transcript.partial_data") {
        // Partial: update in-progress utterance (replaces previous partial for this participant)
        session.activePartials.set(participantId, { speaker, text: words });
      } else if (event === "transcript.data") {
        // Final: commit to pending segments, clear partial
        session.pendingSegments.push({ speaker, text: words });
        session.activePartials.delete(participantId);
        session.lastSegmentIndex++;
      }

      log.debug("Webhook transcript", {
        sessionId,
        botId,
        event,
        speaker,
        wordCount: words.split(" ").length,
      });
    } catch (err) {
      log.error("Webhook parse error", { error: String(err) });
    }
  }

  private createSession(body: {
    botId: string;
    botName: string;
    meetingUrl: string;
    apiKey: string;
    region: string;
    context: MeetingMonitorContext;
  }): MeetingSession {
    const id = randomUUID();

    const session: MeetingSession = {
      id,
      botId: body.botId,
      botName: body.botName,
      meetingUrl: body.meetingUrl,
      apiKey: body.apiKey,
      region: body.region,
      context: body.context,
      lastSegmentIndex: 0,
      pendingSegments: [],
      activePartials: new Map(),
      lastDispatchTime: Date.now(),
      idlePollCount: 0,
      pollTimer: null,
      pollCount: 0,
      status: "monitoring",
      endedAt: null,
    };

    this.sessions.set(id, session);
    this.sessionsByBotId.set(body.botId, id);

    session.pollTimer = setInterval(() => {
      this.pollSession(id).catch((err) => {
        log.error("Poll session error", { sessionId: id, botId: session.botId, error: String(err) });
      });
    }, POLL_INTERVAL_MS);

    log.info("Meeting session created", {
      sessionId: id,
      botId: body.botId,
      botName: body.botName,
      meetingUrl: body.meetingUrl,
      agentId: body.context.agentId,
    });

    return session;
  }

  private async pollSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "monitoring") return;

    session.pollCount++;

    // Check dispatch conditions — include active partials as dispatchable content
    const hasContent = session.pendingSegments.length > 0 || session.activePartials.size > 0;
    const timeSinceDispatch = Date.now() - session.lastDispatchTime;
    const shouldDispatch =
      (timeSinceDispatch >= BATCH_WINDOW_MS && hasContent) ||
      (session.idlePollCount >= IDLE_FLUSH_POLLS && hasContent);

    if (shouldDispatch) {
      this.dispatchBatch(session);
    }

    // Check bot status every 3rd poll
    if (session.pollCount % 3 === 0) {
      await this.checkBotStatus(session);
    }
  }

  private async checkBotStatus(session: MeetingSession): Promise<void> {
    try {
      const statusUrl = `https://${session.region}.recall.ai/api/v1/bot/${session.botId}/`;
      const statusRes = await fetch(statusUrl, {
        headers: { Authorization: `Token ${session.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (!statusRes.ok) {
        log.warn("Bot status check failed", { sessionId: session.id, botId: session.botId, status: statusRes.status });
        return;
      }

      const botData = await statusRes.json();
      const statusChanges = botData.status_changes;

      if (Array.isArray(statusChanges) && statusChanges.length > 0) {
        const lastCode = statusChanges[statusChanges.length - 1].code;

        if (TERMINAL_STATUSES.has(lastCode)) {
          log.info("Meeting reached terminal status", {
            sessionId: session.id,
            botId: session.botId,
            statusCode: lastCode,
          });

          // Fetch full transcript from the recording artifact download URL
          const fullSegments = await this.fetchFullTranscript(session, botData);
          this.dispatchEnd(session, fullSegments);
          return;
        }
      }
    } catch (err) {
      log.error("Bot status check error", {
        sessionId: session.id,
        botId: session.botId,
        error: String(err),
      });
    }
  }

  private async fetchFullTranscript(
    session: MeetingSession,
    botData: any,
  ): Promise<{ speaker: string; text: string }[]> {
    // Try to get transcript download URL from recordings
    const recordings = Array.isArray(botData.recordings) ? botData.recordings : [];
    const recording = recordings[0];
    const downloadUrl = recording?.media_shortcuts?.transcript?.data?.download_url;

    if (!downloadUrl) {
      log.warn("No transcript download URL available", { sessionId: session.id, botId: session.botId });
      // Fall back to whatever segments we accumulated from webhooks
      return [...session.pendingSegments];
    }

    try {
      const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        log.warn("Transcript download failed", { sessionId: session.id, status: res.status });
        return [...session.pendingSegments];
      }

      const data = await res.json();
      // Transcript format: array of segments with speaker + words
      const entries = Array.isArray(data) ? data : (Array.isArray(data.results) ? data.results : []);

      return entries.map((entry: any) => ({
        speaker: entry.speaker ?? entry.participant?.name ?? "Unknown",
        text: Array.isArray(entry.words)
          ? entry.words.map((w: any) => w.text).join(" ")
          : (typeof entry.text === "string" ? entry.text : ""),
      }));
    } catch (err) {
      log.error("Transcript download error", { sessionId: session.id, error: String(err) });
      return [...session.pendingSegments];
    }
  }

  private dispatchBatch(session: MeetingSession): void {
    // Collect finalized segments + any in-progress partials
    const segments = session.pendingSegments.splice(0, session.pendingSegments.length);
    for (const partial of session.activePartials.values()) {
      segments.push({ speaker: partial.speaker, text: `${partial.text} [still speaking...]` });
    }
    session.activePartials.clear();
    session.lastDispatchTime = Date.now();

    if (segments.length === 0) return;

    const item: WorkItem = {
      id: `meeting:${session.botId}:${Date.now()}`,
      text: [
        `[Meeting transcript update — ${session.botName}]`,
        `Bot ID: ${session.botId}`,
        ``,
        `New transcript:`,
        ...segments.map(s => `[${s.speaker}]: ${s.text}`),
        ``,
        `---`,
        `You are participating in this meeting. Use recall_send_chat with bot_id "${session.botId}" if you have relevant input. Otherwise respond "No response needed."`,
      ].join("\n"),
      source: {
        kind: (session.context.channelKind || "internal") as ChannelKind,
        id: session.context.channelId,
        label: session.context.channelLabel,
        adapterId: session.context.adapterId,
      },
      sender: "system",
      threadId: session.context.threadId,
      timestamp: new Date(),
      meta: {
        slackTs: session.context.slackTs,
        slackThreadTs: session.context.slackThreadTs,
        meetingBotId: session.botId,
      },
    };

    log.info("Dispatching transcript batch", {
      sessionId: session.id,
      botId: session.botId,
      segmentCount: segments.length,
    });

    this.onUpdate(item);
  }

  private dispatchEnd(session: MeetingSession, allSegments: { speaker: string; text: string }[]): void {
    const item: WorkItem = {
      id: `meeting:${session.botId}:${Date.now()}`,
      text: [
        `[Meeting ended — ${session.botName}]`,
        `Bot ID: ${session.botId}`,
        ``,
        `Full transcript:`,
        ...allSegments.map(s => `[${s.speaker}]: ${s.text}`),
        ``,
        `---`,
        `Meeting has ended. Produce a summary: key decisions made, action items with owners, and open questions.`,
      ].join("\n"),
      source: {
        kind: (session.context.channelKind || "internal") as ChannelKind,
        id: session.context.channelId,
        label: session.context.channelLabel,
        adapterId: session.context.adapterId,
      },
      sender: "system",
      threadId: session.context.threadId,
      timestamp: new Date(),
      meta: {
        slackTs: session.context.slackTs,
        slackThreadTs: session.context.slackThreadTs,
        meetingBotId: session.botId,
      },
    };

    log.info("Dispatching meeting end", {
      sessionId: session.id,
      botId: session.botId,
      totalSegments: allSegments.length,
    });

    this.onUpdate(item);

    // Clean up the session
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = null;
    }
    session.status = "ended";
    session.endedAt = Date.now();
  }

  sweep(sessionTtlMs: number): SweepResult {
    const cutoff = Date.now() - sessionTtlMs;
    let pruned = 0;

    for (const [id, session] of this.sessions) {
      if (session.endedAt === null) continue;
      if (session.endedAt > cutoff) continue;

      // Clear any lingering timers
      if (session.pollTimer) {
        clearInterval(session.pollTimer);
        session.pollTimer = null;
      }

      // Remove from both maps
      this.sessionsByBotId.delete(session.botId);
      this.sessions.delete(id);
      pruned++;
    }

    return { component: "meeting-monitor", pruned, retried: 0, bytesFreed: 0, errors: [] };
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }
}
