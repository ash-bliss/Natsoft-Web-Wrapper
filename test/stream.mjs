import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:8787/api/live?meeting=DEMO");
let snap = null, bytes = 0, fulls = 0, patches = 0;
const t0 = Date.now();
function applyPatch(p) {
  if (p.header) { const { cars, raceControl } = snap; snap = { ...p.header, cars, raceControl }; }
  if (p.cars || p.order) {
    const byId = new Map(snap.cars.map((c) => [c.id, c]));
    for (const c of p.cars || []) byId.set(c.id, c);
    snap.cars = (p.order || snap.cars.map((c) => c.id)).map((id) => byId.get(id)).filter(Boolean);
  }
  if (p.raceControl) snap.raceControl = p.raceControl;
}
ws.on("message", (d) => {
  bytes += d.length;
  const m = JSON.parse(d);
  if (m.type === "full") { snap = m.data; fulls++; } else { applyPatch(m.data); patches++; }
});
setTimeout(async () => {
  const secs = (Date.now() - t0) / 1000;
  const server = await fetch("http://127.0.0.1:8787/api/state?meeting=DEMO").then((r) => r.json());
  const strip = (s) => JSON.stringify({ ...s, updatedAt: 0, trackTime: 0, cars: s.cars.map(c => ({...c})) });
  // allow the server to have moved on a tick; compare car order + laps of leader-ish fields
  console.log(`fulls=${fulls} patches=${patches} in ${secs.toFixed(0)}s, ${(bytes/secs/1024).toFixed(2)} KB/s ≈ ${(bytes/secs*3600/1048576).toFixed(1)} MB/hour`);
  console.log("flag", snap.flag, "| clock", JSON.stringify(snap.clock), "| cars", snap.cars.length, "| RC msgs", snap.raceControl.length);
  console.log("client top5", snap.cars.slice(0,5).map(c=>`${c.pos}:#${c.no} L${c.laps} ${c.gap ?? ''}`).join("  "));
  console.log("server top5", server.cars.slice(0,5).map(c=>`${c.pos}:#${c.no} L${c.laps} ${c.gap ?? ''}`).join("  "));
  const same = JSON.stringify(snap.cars.map(c=>[c.id,c.pos,c.laps,c.last,c.gap])) === JSON.stringify(server.cars.map(c=>[c.id,c.pos,c.laps,c.last,c.gap]));
  console.log("patched client state matches server:", same);
  process.exit(0);
}, 45000);
