import { checkNatsoft, normaliseMeeting } from "./natsoft";
import type { Env } from "./relay";
import type { Connector } from "./wsclient";

export { Relay } from "./relay";

const connector: Connector = async (host, port, tls) => {
  const { connect } = await import("cloudflare:sockets");
  const sock = connect({ hostname: host, port }, { secureTransport: tls ? "on" : "off", allowHalfOpen: false });
  await sock.opened;
  return { readable: sock.readable, writable: sock.writable, close: () => sock.close() };
};

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });

/** If ACCESS_KEY is set, the API needs ?key=… (the page asks for it once and remembers it). */
function authorised(request: Request, url: URL, env: Env): boolean {
  if (!env.ACCESS_KEY) return true;
  const given = url.searchParams.get("key") ?? request.headers.get("X-Access-Key") ?? "";
  if (given.length !== env.ACCESS_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.ACCESS_KEY.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (url.pathname === "/api/config") return json({ needsKey: !!env.ACCESS_KEY });
    if (!authorised(request, url, env)) return json({ error: "access key required" }, 401);
    if (url.pathname === "/api/auth") return json({ ok: true });

    const meeting = normaliseMeeting(url.searchParams.get("meeting") ?? "");
    if (!meeting) return json({ error: "missing or invalid meeting ID" }, 400);

    if (url.pathname === "/api/check") {
      if (meeting.toUpperCase() === "DEMO") return json({ meeting, ok: true, steps: [{ step: "Demo feed", ok: true, detail: "runs inside the relay", ms: 0 }] });
      return json(await checkNatsoft(meeting, connector));
    }

    if (url.pathname === "/api/live" || url.pathname === "/api/state") {
      // One relay per meeting, shared by everyone watching it.
      const stub = env.RELAY.get(env.RELAY.idFromName(meeting.toUpperCase()));
      const forward = new URL(request.url);
      forward.searchParams.set("meeting", meeting);
      return stub.fetch(new Request(forward.toString(), request));
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
