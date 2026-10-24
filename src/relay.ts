import { DurableObject } from "cloudflare:workers";
import { runDemo } from "./demo";
import { FeedStatus, runNatsoft } from "./natsoft";
import { LiveTiming, Snapshot } from "./timing";
import { Connector } from "./wsclient";

export interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  ASSETS: Fetcher;
  ACCESS_KEY?: string;
}

/** How long the Natsoft connection stays open after the last viewer leaves or the last /api/state poll. */
const IDLE_MS = 2 * 60_000;
/** At most this often, viewers get an update. */
const BROADCAST_MS = 500;

type Car = Snapshot["cars"][number];
type Header = Omit<Snapshot, "cars" | "raceControl">;

/** Drops empty fields and rounds times to the millisecond, all the way down (including the car list). */
function compact<T>(v: T): T {
  if (typeof v === "number") return (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000) as T;
  if (Array.isArray(v)) return v.map((x) => compact(x)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== null) out[k] = compact(x);
    return out as T;
  }
  return v;
}

/**
 * One relay per meeting ID. Holds the single upstream connection to Natsoft, keeps the timing state, and fans
 * updates out to every viewer: a full snapshot on join, then patches with only what changed.
 */
export class Relay extends DurableObject<Env> {
  private meeting = "";
  private timing = new LiveTiming();
  private status: FeedStatus = "idle";
  private statusDetail?: string;
  private feed?: AbortController;
  private viewers = new Set<WebSocket>();
  private lastPollAt = 0;
  private broadcastTimer?: ReturnType<typeof setTimeout>;
  private lastBroadcastAt = 0;
  private sent?: { header: string; cars: Map<string, string>; order: string; rc: string };
  private idleTimer?: ReturnType<typeof setInterval>;

  private connector: Connector = async (host, port, tls) => {
    const { connect } = await import("cloudflare:sockets");
    const sock = connect({ hostname: host, port }, { secureTransport: tls ? "on" : "off", allowHalfOpen: false });
    await sock.opened;
    return { readable: sock.readable, writable: sock.writable, close: () => sock.close() };
  };

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const meeting = url.searchParams.get("meeting") ?? "";
    if (!this.meeting) this.meeting = meeting;

    if (url.pathname === "/api/live") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      this.viewers.add(server);
      server.addEventListener("message", (e) => { if (e.data === "ping") safeSend(server, '{"type":"pong"}'); });
      const drop = () => { this.viewers.delete(server); this.scheduleIdleCheck(); };
      server.addEventListener("close", drop);
      server.addEventListener("error", drop);
      this.ensureFeed();
      safeSend(server, JSON.stringify({ type: "full", data: this.fullSnapshot() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/api/state") {
      this.lastPollAt = Date.now();
      this.ensureFeed();
      this.scheduleIdleCheck();
      return Response.json(this.fullSnapshot(), { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }

    return new Response("Not found", { status: 404 });
  }

  private ensureFeed() {
    if (this.feed) return;
    const ac = new AbortController();
    this.feed = ac;
    this.timing = new LiveTiming();
    this.sent = undefined;
    const handlers = {
      status: (s: FeedStatus, detail?: string) => {
        this.status = s;
        this.statusDetail = detail;
        if (s === "notLive" || s === "connecting") { /* keep the last data visible until a new snapshot arrives */ }
        this.queueBroadcast(true);
      },
      message: (xml: string) => {
        this.timing.apply(xml);
        this.queueBroadcast(false);
      },
    };
    const run = this.meeting.toUpperCase() === "DEMO"
      ? runDemo(handlers, ac.signal)
      : runNatsoft(this.meeting, this.connector, handlers, ac.signal);
    run.catch((e) => { this.status = "retrying"; this.statusDetail = String(e); this.queueBroadcast(true); })
      .finally(() => { if (this.feed === ac) this.feed = undefined; });
    this.scheduleIdleCheck();
  }

  private stopFeed() {
    this.feed?.abort();
    this.feed = undefined;
    this.status = "idle";
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined; }
  }

  private scheduleIdleCheck() {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      const idle = this.viewers.size === 0 && Date.now() - this.lastPollAt > IDLE_MS;
      if (idle) this.stopFeed();
    }, 15_000);
  }

  private fullSnapshot(): Snapshot {
    return compact(this.timing.snapshot(this.meeting, this.status, this.statusDetail));
  }

  private queueBroadcast(immediate: boolean) {
    if (this.viewers.size === 0) return;
    if (this.broadcastTimer) { if (!immediate) return; clearTimeout(this.broadcastTimer); }
    const wait = immediate ? 0 : Math.max(0, BROADCAST_MS - (Date.now() - this.lastBroadcastAt));
    this.broadcastTimer = setTimeout(() => { this.broadcastTimer = undefined; this.broadcast(); }, wait);
  }

  /** Sends only what changed since the last broadcast. New viewers already got a full snapshot. */
  private broadcast() {
    this.lastBroadcastAt = Date.now();
    const snap = this.fullSnapshot();
    const { cars, raceControl, ...header } = snap;
    const headerJson = JSON.stringify(header);
    const carJson = new Map(cars.map((c) => [c.id, JSON.stringify(c)] as const));
    const order = cars.map((c) => c.id).join(",");
    const rc = JSON.stringify(raceControl);

    let msg: string;
    if (!this.sent) {
      msg = JSON.stringify({ type: "full", data: snap });
    } else {
      const patch: { header?: Header; cars?: Car[]; order?: string[]; raceControl?: Snapshot["raceControl"] } = {};
      if (headerJson !== this.sent.header) patch.header = header;
      const changed = cars.filter((c) => this.sent!.cars.get(c.id) !== carJson.get(c.id));
      if (changed.length) patch.cars = changed;
      if (order !== this.sent.order) patch.order = cars.map((c) => c.id);
      if (rc !== this.sent.rc) patch.raceControl = raceControl;
      if (Object.keys(patch).length === 0) return;
      msg = JSON.stringify({ type: "patch", data: patch });
    }
    this.sent = { header: headerJson, cars: carJson, order, rc };
    for (const ws of this.viewers) safeSend(ws, msg);
  }
}

function safeSend(ws: WebSocket, msg: string) {
  try { ws.send(msg); } catch { /* closed */ }
}
