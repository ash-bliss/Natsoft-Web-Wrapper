// Local tests: decoder, XML reader, timing model, and the TCP WebSocket client against a fake Natsoft server.
import { readFileSync } from "node:fs";
import https from "node:https";
import tls from "node:tls";
import { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import assert from "node:assert/strict";
import { decodeFrame, encodeFrame, rootName } from "../src/decoder";
import { parseXml } from "../src/xml";
import { LiveTiming } from "../src/timing";
import { runNatsoft, checkNatsoft, normaliseMeeting, USER_AGENT, parseToken } from "../src/natsoft";
import type { Connector } from "../src/wsclient";
import * as natsoft from "../src/natsoft";

let passed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log("  ✓", name); }
  catch (e) { console.log("  ✗", name); throw e; }
}

// ---------- decoder ----------
await test("plain XML passes through", () => assert.equal(decodeFrame("<NotFound />\r\n"), "<NotFound />\r\n"));
await test("XOR chain round-trips", () => {
  const xml = `<L T="1791626814.7636" Y="p" L="25"><P L="24" C="4" D="2"><D LP="2" /></P></L>`;
  assert.equal(decodeFrame(encodeFrame(xml)), xml);
});
await test("control codes expand", () => {
  const enc = String.fromCharCode("<".charCodeAt(0) ^ 0x7f, "S".charCodeAt(0) ^ "<".charCodeAt(0), 23 ^ "S".charCodeAt(0), "5".charCodeAt(0) ^ 23);
  assert.equal(decodeFrame(enc), `<S T="5`);
});
await test("root names", () => {
  assert.equal(rootName(`<New T="1">`), "New");
  assert.equal(rootName("  <L Y=\"p\" />"), "L");
  assert.equal(rootName("garbage"), "?");
});
await test("meeting IDs and links", () => {
  assert.equal(normaliseMeeting("V8SUPER"), "V8SUPER");
  assert.equal(normaliseMeeting(" 20261011.MOUN "), "20261011.MOUN");
  assert.equal(normaliseMeeting("https://server.natsoft.com.au:8080/LiveMeeting/V8SUPER?x=1"), "V8SUPER");
  assert.equal(normaliseMeeting("bad id/../x"), undefined);
});
await test("token parsing", () => assert.equal(parseToken(`<script>var gsLiveToken="abc123";</script>`), "abc123"));

// ---------- XML ----------
await test("XML: nested, self-closing, entities, multiple roots", () => {
  const roots = parseXml(`<?xml version="1.0"?><L Y="p"><P L="1" C="22"><D I="83.1" /></P></L><G R="Cars 19 &amp; 48 &quot;noted&quot;" C="" />`);
  assert.equal(roots.length, 2);
  assert.equal(roots[0].children[0].children[0].attrs.I, "83.1");
  assert.equal(roots[1].attrs.R, `Cars 19 & 48 "noted"`);
  assert.equal(roots[1].attrs.C, "");
});
await test("XML: '>' inside an attribute value", () => {
  const [r] = parseXml(`<G R="a > b" />`);
  assert.equal(r.attrs.R, "a > b");
});

// ---------- timing model ----------
const SNAP = `<New T="1000.0000"><M D="2026 Boost Mobile Gold Coast 500" Y="V8SUPER" /><T C="SPSC" N="SURFERS PARADISE STREET CIRCUIT" P="7" />`
  + `<E C="R1" D="2026 Tyrepower V8 SuperUte Series - Race 2" Y="Race" L="12" RI="83.5180" RC="Cameron_Crick" RV="Isuzu" />`
  + `<RL><R ID="22" N="88" V="Toyota Hilux"><V ID="1" N="Justin Ruggier" /></R><R ID="9" N="29" V="Mitsubishi Triton"><V ID="1" N="Jack Westbury" /></R></RL>`
  + `<L Y="f"><P L="1" C="22" D="1"><D L="0" P="N" /></P><P L="2" C="9" D="1"><D L="0" P="N" /></P></L>`
  + `<C Y="L" C="12" E="0" /><S S="Green" /><A I="0.0000" C="" /></New>`;
await test("timing: snapshot, deltas, position change, blank session best", () => {
  const t = new LiveTiming();
  t.apply(SNAP, 1);
  assert.equal(t.trackName, "Surfers Paradise Street Circuit");
  assert.equal(t.best.lap, undefined);
  assert.equal(t.best.carId, undefined);
  assert.equal(t.record?.driver, "Cameron Crick");
  t.apply(`<L T="1010" Y="p"><P L="1" C="9" D="1"><D L="1" I="85.123" FI="85.123" FL="1" S1="24.9" GI="0.0000" /></P><P L="2" C="22" D="1"><D L="1" GI="0.230" GNI="0.230" GL="0" /></P></L>`, 2);
  t.apply(`<A I="85.123" C="9" S1="24.9" />`, 3);
  t.apply(`<G R="Stewards: Car 19 under investigation" C="" />`, 4);
  const s = t.snapshot("V8SUPER", "live");
  assert.deepEqual(s.cars.map((c) => c.no), ["29", "88"]);
  assert.equal(s.cars[0].posDelta, 1);
  assert.equal(s.cars[1].gap, 0.23);
  assert.equal(s.best.number, "29");
  assert.equal(s.best.driver, "Jack Westbury");
  assert.equal(s.raceControl[0].text, "Stewards: Car 19 under investigation");
  assert.equal(s.isRace, true);
});
await test("timing: S1 starts a new lap's sectors; pit in/out", () => {
  const t = new LiveTiming();
  t.apply(SNAP);
  t.apply(`<L><P C="22"><D S1="24.1" S2="31.4" S3="30.2" /></P></L>`);
  t.apply(`<L><P C="22"><D S1="24.5" /></P></L>`);
  const c = t.cars.get("22")!;
  assert.equal(c.s1, 24.5); assert.equal(c.s2, undefined); assert.equal(c.s3, undefined);
  t.apply(`<L><P C="22"><D P="Y" PF="P" PS="1" /></P></L>`);
  assert.equal(t.cars.get("22")!.inPit, true);
  t.apply(`<L><P C="22"><D P="N" PF="T" PT="32.1" /></P></L>`);
  assert.equal(t.cars.get("22")!.inPit, false);
  assert.equal(t.cars.get("22")!.pitStops, 1);
});

// ---------- WebSocket client vs a fake Natsoft ----------
const key = readFileSync(new URL("./key.pem", import.meta.url));
const cert = readFileSync(new URL("./cert.pem", import.meta.url));
const TOKEN = "T0K3N+/=" + "x".repeat(290);
const seen: Array<{ path: string; ua?: string; origin?: string }> = [];

const server = https.createServer({ key, cert }, (req, res) => {
  if (req.url?.startsWith("/LiveMeeting/")) {
    res.writeHead(200, { "Content-Type": "text/html" }); // chunked (no content-length)
    res.write("<html><head><script>");
    res.end(`var gsLiveToken="${TOKEN}";</script></head></html>`);
  } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server });
let redirected = false;
wss.on("connection", (ws, req) => {
  const u = new URL(req.url!, "https://x");
  seen.push({ path: u.pathname + u.search, ua: req.headers["user-agent"], origin: req.headers.origin });
  const ok = u.searchParams.get("Token") === TOKEN && req.headers["user-agent"] === USER_AGENT;
  const meeting = u.pathname.split("/").pop();
  if (!ok || meeting === "OFF") { ws.send("<NotFound />\r\n"); return; }
  if (meeting === "HOP" && !redirected) {
    redirected = true;
    ws.send(`<Redirect URL="https://localhost:${port}/LiveMeeting/V8SUPER?Seq=4" />`);
    return;
  }
  ws.ping();
  ws.send(encodeFrame(SNAP));
  const big = `<L Y="p">` + `<P C="22"><D LP="1" /></P>`.repeat(4000) + `</L>`; // > 64 KB: 64-bit length
  ws.send(encodeFrame(big));
  ws.send(`<C Y="L" C="11"`, { fin: false });
  ws.send(` E="1" />`, { fin: true });
  ws.send(encodeFrame(`<S S="Yellow" />`));
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

// Point the client at the fake server instead of server.natsoft.com.au:8080
const fakeConnector: Connector = async (_host, _port, _tls) => {
  const sock = tls.connect({ host: "localhost", port, rejectUnauthorized: false });
  await new Promise<void>((res, rej) => { sock.once("secureConnect", () => res()); sock.once("error", rej); });
  const web = Duplex.toWeb(sock) as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  return { readable: web.readable, writable: web.writable, close: () => { sock.destroy(); } };
};

async function collect(meeting: string, until: (msgs: string[], statuses: string[]) => boolean, ms = 8000) {
  const msgs: string[] = [], statuses: string[] = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const done = runNatsoft(meeting, fakeConnector, {
    status: (s, d) => { statuses.push(d ? `${s}:${d}` : s); if (until(msgs, statuses)) ac.abort(); },
    message: (x) => { msgs.push(x); if (until(msgs, statuses)) ac.abort(); },
  }, ac.signal);
  await done;
  clearTimeout(timer);
  return { msgs, statuses };
}

await test("client: token page (chunked), token + User-Agent on the socket, encoded/big/fragmented frames, ping", async () => {
  const { msgs, statuses } = await collect("V8SUPER", (m) => m.length >= 4);
  assert.equal(statuses[0], "connecting");
  assert.equal(statuses[1], "live");
  assert.equal(rootName(msgs[0]), "New");
  assert.ok(msgs[1].length > 64 * 1024, "big frame arrived whole");
  assert.equal(msgs[2], `<C Y="L" C="11" E="1" />`);
  assert.equal(msgs[3], `<S S="Yellow" />`);
  const conn = seen[seen.length - 1];
  assert.ok(conn.path.includes("Token=" + encodeURIComponent(TOKEN)));
  assert.equal(conn.origin, "https://server.natsoft.com.au:8080");
  const t = new LiveTiming();
  for (const m of msgs) t.apply(m);
  assert.equal(t.flag, "Yellow");
  assert.equal(t.clockRemaining, 11);
});

await test("client: <NotFound/> reports not live", async () => {
  const { statuses } = await collect("OFF", (_m, s) => s.includes("notLive"));
  assert.ok(statuses.includes("notLive"));
});

await test("client: follows <Redirect/> and keeps the token", async () => {
  const before = seen.length;
  const { msgs } = await collect("HOP", (m) => m.length >= 1);
  assert.equal(rootName(msgs[0]), "New");
  const hop = seen.slice(before);
  assert.equal(hop.length, 2);
  assert.ok(hop[1].path.startsWith("/LiveMeeting/V8SUPER?Seq=4&Token="));
});

await test("client: connection failures retry with a reason", async () => {
  const dead: Connector = async () => { throw new Error("connect ECONNREFUSED"); };
  const ac = new AbortController();
  const statuses: string[] = [];
  const p = runNatsoft("V8SUPER", dead, { status: (s, d) => { statuses.push(`${s}:${d ?? ""}`); if (s === "retrying") ac.abort(); }, message: () => {} }, ac.signal);
  await p;
  assert.ok(statuses.some((s) => s.startsWith("retrying:") && s.includes("ECONNREFUSED")));
});

await test("connection check: all steps pass against the fake server", async () => {
  const r = await checkNatsoft("V8SUPER", fakeConnector);
  for (const s of r.steps) console.log(`      ${s.ok ? "ok " : "BAD"} ${s.step} — ${s.detail}`);
  assert.equal(r.ok, true);
});

void natsoft;
server.close();
console.log(`\n${passed} tests passed`);
process.exit(0);
