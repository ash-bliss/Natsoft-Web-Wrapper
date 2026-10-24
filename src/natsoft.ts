import { decodeFrame, rootName } from "./decoder";
import { Connector, HandshakeError, WebSocketConnection, httpGet } from "./wsclient";

export const NATSOFT_BASE = "https://server.natsoft.com.au:8080";
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

export type FeedStatus = "idle" | "connecting" | "live" | "notLive" | "retrying" | "demo";

export interface FeedHandlers {
  status(status: FeedStatus, detail?: string): void;
  message(xml: string): void;
}

/** Meeting IDs look like V8SUPER or 20261011.MOUN. Also accepts a pasted LiveMeeting link. */
export function normaliseMeeting(input: string): string | undefined {
  let s = decodeURIComponent(input.trim());
  const m = /LiveMeeting\/([^/?#\s]+)/i.exec(s);
  if (m) s = m[1];
  return /^[A-Za-z0-9._-]{1,40}$/.test(s) ? s : undefined;
}

export function pageUrl(meeting: string) { return new URL(`${NATSOFT_BASE}/LiveMeeting/${encodeURIComponent(meeting)}`); }

export function socketUrl(meeting: string) {
  const u = pageUrl(meeting);
  u.protocol = "wss:";
  return u;
}

export function withToken(url: URL, token?: string): URL {
  if (!token || url.search.includes("Token=")) return url;
  const sep = url.search ? "&" : "?";
  return new URL(url.toString() + sep + "Token=" + encodeURIComponent(token));
}

export function parseToken(html: string): string | undefined {
  const m = /gsLiveToken\s*=\s*"([^"]*)"/.exec(html);
  return m && m[1] ? m[1] : undefined;
}

export function redirectTarget(xml: string): URL | undefined {
  const m = /URL="([^"]+)"/.exec(xml);
  if (!m) return undefined;
  let s = m[1].replace(/&amp;/g, "&");
  if (s.startsWith("https:")) s = "wss:" + s.slice(6);
  else if (s.startsWith("http:")) s = "ws:" + s.slice(5);
  try { return new URL(s); } catch { return undefined; }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

function describe(e: unknown): string {
  if (e instanceof HandshakeError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
}

/**
 * One polite connection to a Natsoft meeting, the same as a single browser tab.
 * Loads the meeting page for its `gsLiveToken`, opens the WebSocket with `?Token=` and the same User-Agent,
 * and never sends anything. <NotFound/> = not live (retry in 30 s); <Redirect/> = reconnect there; errors retry in 10 s.
 */
export async function runNatsoft(meeting: string, connector: Connector, h: FeedHandlers, signal: AbortSignal) {
  let target = socketUrl(meeting);
  let token: string | undefined;
  let tokenFetched = false;

  while (!signal.aborted) {
    h.status("connecting");
    if (!tokenFetched) {
      token = await fetchToken(meeting, connector).catch(() => undefined);
      tokenFetched = true;
    }
    if (signal.aborted) return;

    let outcome: { kind: "notFound" } | { kind: "redirect"; url: URL } | { kind: "failed"; why: string } =
      { kind: "failed", why: "connection closed" };
    let ws: WebSocketConnection | undefined;
    const onAbort = () => { ws?.close(); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      ws = await WebSocketConnection.open(connector, withToken(target, token), {
        Origin: NATSOFT_BASE,
        "User-Agent": USER_AGENT,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      });
      let announced = false;
      for await (const raw of ws.messages()) {
        if (signal.aborted) break;
        const xml = decodeFrame(raw);
        const root = rootName(xml);
        if (root === "NotFound") { outcome = { kind: "notFound" }; break; }
        if (root === "Redirect") {
          const url = redirectTarget(xml);
          if (url) { outcome = { kind: "redirect", url }; break; }
          continue;
        }
        if (!announced) { announced = true; h.status("live"); }
        h.message(xml);
      }
    } catch (e) {
      outcome = { kind: "failed", why: describe(e) };
    } finally {
      signal.removeEventListener("abort", onAbort);
      try { await ws?.close(); } catch { /* ignore */ }
    }
    if (signal.aborted) return;

    switch (outcome.kind) {
      case "notFound":
        h.status("notLive");
        target = socketUrl(meeting);
        tokenFetched = false;
        await sleep(30_000, signal);
        break;
      case "redirect":
        target = outcome.url; // keep the token across a redirect, like the browser
        break;
      case "failed":
        h.status("retrying", outcome.why);
        target = socketUrl(meeting);
        tokenFetched = false;
        await sleep(10_000, signal);
        break;
    }
  }
}

export async function fetchToken(meeting: string, connector: Connector): Promise<string | undefined> {
  const res = await httpGet(connector, pageUrl(meeting), {
    "User-Agent": USER_AGENT,
    Referer: "https://www.supercars.com/",
  });
  return parseToken(res.body);
}

/** Step-by-step check of whether this host can reach Natsoft, for the /api/check page. */
export async function checkNatsoft(meeting: string, connector: Connector) {
  const steps: Array<{ step: string; ok: boolean; detail: string; ms: number }> = [];
  const time = async <T>(step: string, fn: () => Promise<T>, detail: (v: T) => string): Promise<T | undefined> => {
    const t0 = Date.now();
    try {
      const v = await fn();
      steps.push({ step, ok: true, detail: detail(v), ms: Date.now() - t0 });
      return v;
    } catch (e) {
      steps.push({ step, ok: false, detail: describe(e), ms: Date.now() - t0 });
      return undefined;
    }
  };

  const page = await time("Load the meeting page (port 8080)", () => httpGet(connector, pageUrl(meeting), {
    "User-Agent": USER_AGENT, Referer: "https://www.supercars.com/",
  }), (r) => `HTTP ${r.status}, ${r.body.length.toLocaleString()} bytes`);
  const token = page ? parseToken(page.body) : undefined;
  if (page) steps.push({ step: "Find the live token on the page", ok: !!token, detail: token ? `${token.length} characters` : "no gsLiveToken on the page (older meetings may not need one)", ms: 0 });

  const ws = await time("Open the live timing WebSocket", () => WebSocketConnection.open(connector, withToken(socketUrl(meeting), token), {
    Origin: NATSOFT_BASE, "User-Agent": USER_AGENT,
  }), () => "upgraded (HTTP 101)");

  if (ws) {
    await time("Wait for the first message", async () => {
      const it = ws.messages();
      const first = await Promise.race([
        it.next(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no message within 15 s")), 15_000)),
      ]);
      if (first.done) throw new Error("server closed without sending anything");
      const xml = decodeFrame(first.value);
      const root = rootName(xml);
      if (root === "NotFound") return "NotFound — reachable, but the meeting isn't live right now";
      if (root === "Redirect") return `Redirect to ${redirectTarget(xml)?.host ?? "?"}`;
      return `<${root}> — ${xml.length.toLocaleString()} characters of live timing`;
    }, (s) => s);
    await ws.close();
  }

  return { meeting, ok: steps.every((s) => s.ok || s.step.startsWith("Find the live token")), steps };
}
