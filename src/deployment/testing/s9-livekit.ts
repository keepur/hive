import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface LivekitMock {
  url: string;
  port: number;
  requests: string[];
  stop(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectPromise);
  });
}

function sipPage(kind: "rule" | "trunk", afterId: string): unknown[] {
  const key = kind === "rule" ? "sipDispatchRuleId" : "sipTrunkId";
  const prefix = kind === "rule" ? "SDR" : "ST";
  const all = Array.from({ length: 101 }, (_, index) => {
    const id = `${prefix}_${String(index + 1).padStart(3, "0")}`;
    return kind === "rule" ? { [key]: id, roomConfig: { agents: [{ agentName: "hive-voice" }] } } : { [key]: id };
  });
  if (!afterId) return all.slice(0, 100);
  const start = all.findIndex((row) => (row as Record<string, string>)[key] === afterId) + 1;
  return all.slice(Math.max(0, start), Math.max(0, start) + 100);
}

export async function startLivekitMock(port: number): Promise<LivekitMock> {
  const requests: string[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    requests.push(`${req.method ?? "GET"} ${url}`);
    const body = await readBody(req).catch(() => "{}");
    let afterId = "";
    try {
      const parsed = JSON.parse(body) as { page?: { afterId?: string; after_id?: string } };
      afterId = parsed.page?.afterId ?? parsed.page?.after_id ?? afterId;
    } catch {
      // keep empty afterId
    }
    let payload: unknown;
    if (url.endsWith("/livekit.RoomService/ListRooms")) {
      payload = { rooms: [{ sid: "RM_s9", name: "s9-room" }] };
    } else if (url.endsWith("/livekit.RoomService/ListParticipants")) {
      payload = { participants: [{ sid: "PA_s9" }] };
    } else if (url.endsWith("/livekit.AgentDispatchService/ListDispatch")) {
      payload = { agentDispatches: [{ id: "AD_s9", agentName: "hive-voice" }] };
    } else if (url.endsWith("/livekit.SIP/ListSIPDispatchRule")) {
      payload = { items: sipPage("rule", afterId) };
    } else if (url.endsWith("/livekit.SIP/ListSIPInboundTrunk")) {
      payload = { items: sipPage("trunk", afterId) };
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ msg: "not found", code: "not_found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.listen(port, "127.0.0.1", () => resolvePromise());
    server.on("error", rejectPromise);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    stop: () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}
