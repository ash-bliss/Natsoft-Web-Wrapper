import type { FeedHandlers } from "./natsoft";

/** A made-up race sent as Natsoft-style XML through the same pipeline as the real feed. Meeting ID: DEMO */
const ROSTER: Array<[string, string, string]> = [
  ["7", "Sam Hartley", "Ford Mustang GT"], ["14", "Mia Corrigan", "Chev Camaro ZL1"],
  ["23", "Josh Pellegrini", "Ford Mustang GT"], ["31", "Ella Whitford", "Toyota Supra GR"],
  ["5", "Liam Okafor", "Chev Camaro ZL1"], ["44", "Ruby Nakamura", "Ford Mustang GT"],
  ["9", "Tom Brennan", "Chev Camaro ZL1"], ["62", "Ava Lindqvist", "Toyota Supra GR"],
  ["18", "Noah Fairweather", "Ford Mustang GT"], ["27", "Chloe Dunmore", "Chev Camaro ZL1"],
  ["3", "Jack Ruthven", "Toyota Supra GR"], ["88", "Isla Carmody", "Ford Mustang GT"],
  ["51", "Harry Teo", "Chev Camaro ZL1"], ["12", "Zoe Abernethy", "Toyota Supra GR"],
];

interface Car {
  id: string; no: string; driver: string; vehicle: string; pace: number;
  laps: number; next: number; cross: Map<number, number>; best: number; bestNo: number; bestS: number[];
  pitOut?: number; stops: number; done: boolean;
}

const f4 = (x: number) => x.toFixed(4);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export async function runDemo(h: FeedHandlers, signal: AbortSignal, tickMs = 250, raceLaps = 15) {
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
  h.status("demo");
  while (!signal.aborted) {
    await race(h, signal, sleep, tickMs, raceLaps);
    await sleep(8000);
  }
}

async function race(h: FeedHandlers, signal: AbortSignal, sleep: (ms: number) => Promise<void>, tickMs: number, raceLaps: number) {
  const offset = -new Date().getTimezoneOffset() * 60; // local wall clock "as UTC", like Natsoft
  const base = Date.now() / 1000 + (offset || 39600);
  const T = (sim: number) => f4(base + sim);
  const cars: Car[] = ROSTER.map(([no, driver, vehicle], i) => ({
    id: String(i + 1), no, driver, vehicle, pace: 79.2 + i * 0.11 + rand(-0.15, 0.15),
    laps: 0, next: 0.35 * i, cross: new Map([[0, 0.35 * i]]), best: 0, bestNo: 0, bestS: [0, 0, 0], stops: 0, done: false,
  }));

  const entries = cars.map((c) => `<R ID="${c.id}" N="${c.no}" V="${c.vehicle}"><V ID="1" N="${esc(c.driver)}" /></R>`).join("");
  const grid = cars.map((c, i) => `<P L="${i + 1}" C="${c.id}" D="1"><D L="0" P="N" PS="0" /></P>`).join("");
  h.message(`<New T="${T(0)}"><M D="Demo Meeting" Y="DEMO" /><T C="DEMO" N="DEMO PARK RACEWAY" P="3" I="2" />`
    + `<E C="R1" D="Demo Series - Race 1" Y="Race" L="${raceLaps}" RI="78.9012" RC="Sam_Hartley" RV="Ford Mustang GT" />`
    + `<RL>${entries}</RL><L T="${T(0)}" Y="f">${grid}</L><C T="${T(0)}" Y="L" C="${raceLaps}" E="0" />`
    + `<S T="${T(0)}" S="WaitStart" E="R1" /><A T="${T(0)}" I="0.0000" C="" /></New>`);
  await sleep(2000);
  h.message(`<S T="${T(0)}" S="Green" E="R1" I="${T(0)}" />`);

  let sim = 0, bestLap = 0, bestCar = "", finished = false, flag = "Green";
  const bestS = [0, 0, 0];
  const leaderCross = new Map<number, number>();
  for (const c of cars) c.next += c.pace + 6 + rand(0, 1.5);

  while (!signal.aborted) {
    sim += 1;
    let items = "";
    const crossing = cars.filter((c) => !c.done && c.next <= sim).sort((a, b) => a.next - b.next);
    for (const c of crossing) {
      const at = c.next;
      const lapTime = at - (c.cross.get(c.laps) ?? 0);
      c.laps++;
      c.cross.set(c.laps, at);
      if (!leaderCross.has(c.laps)) leaderCross.set(c.laps, at);
      const s = [lapTime * 0.31 + rand(-0.12, 0.12), lapTime * 0.37 + rand(-0.12, 0.12), 0];
      s[2] = lapTime - s[0] - s[1];
      const pitting = c.laps === 7 && (c.id === "5" || c.id === "10");
      const clean = c.laps > 1 && c.pitOut === undefined;
      let newBest = false;
      if (clean && (!c.best || lapTime < c.best)) {
        c.best = lapTime; c.bestNo = c.laps;
        if (!bestLap || lapTime < bestLap) { bestLap = lapTime; bestCar = c.id; newBest = true; }
      }
      if (clean) for (let k = 0; k < 3; k++) {
        if (!c.bestS[k] || s[k] < c.bestS[k]) c.bestS[k] = s[k];
        if (!bestS[k] || s[k] < bestS[k]) { bestS[k] = s[k]; newBest = true; }
      }
      const order = [...cars].sort((a, b) => a.laps !== b.laps ? b.laps - a.laps : (a.cross.get(a.laps) ?? Infinity) - (b.cross.get(b.laps) ?? Infinity));
      const pos = order.indexOf(c) + 1;
      let gaps = `GI="0.0000" GL="0" GNI="0.0000" GNL="0"`;
      if (pos > 1) {
        const leader = order[0], ahead = order[pos - 2];
        const down = leader.laps - c.laps, aheadDown = ahead.laps - c.laps;
        gaps = down > 0 ? `GI="0.0000" GL="${down}"` : `GI="${f4(at - (leaderCross.get(c.laps) ?? at))}" GL="0"`;
        gaps += aheadDown > 0 ? ` GNI="0.0000" GNL="${aheadDown}"` : ` GNI="${f4(at - (ahead.cross.get(c.laps) ?? at))}" GNL="0"`;
      }
      let d = `L="${c.laps}" I="${f4(lapTime)}" S1="${f4(s[0])}" S2="${f4(s[1])}" S3="${f4(s[2])}" LP="M" SP="${Math.round(rand(248, 271))}" ${gaps}`;
      if (c.best) d += ` FI="${f4(c.best)}" FL="${c.bestNo}" FS1="${f4(c.bestS[0])}" FS2="${f4(c.bestS[1])}" FS3="${f4(c.bestS[2])}"`;
      if (pitting) { c.stops++; c.pitOut = at + 24; d += ` P="Y" PF="P" PS="${c.stops}"`; }
      items += `<P L="${pos}" C="${c.id}" D="1"><D ${d} /></P>`;
      order.forEach((o, n) => { if (o !== c) items += `<P L="${n + 1}" C="${o.id}" D="1" />`; });
      if (newBest) h.message(`<A T="${T(at)}" I="${f4(bestLap)}" C="${bestCar}" S1="${f4(bestS[0])}" S2="${f4(bestS[1])}" S3="${f4(bestS[2])}" />`);

      let next = c.pace + rand(-0.35, 0.45) - Math.min(c.laps, 10) * 0.03;
      if (pitting) next += 24;
      if (flag === "Yellow") next += 9;
      c.next = at + next;

      if (finished) c.done = true;
      if (pos === 1) {
        if (c.laps >= raceLaps && !finished) { finished = true; c.done = true; h.message(`<S T="${T(at)}" S="Checkered" E="R1" />`); }
        if (c.laps === 4) h.message(`<G T="${T(at)}" R="Race Control: Turn 6 incident involving cars 23 &amp; 31 noted" C="" />`);
        if (c.laps === 6) h.message(`<G T="${T(at)}" R="Stewards: Car 23 - 5 second time penalty - causing a collision" C="" />`);
        if (c.laps === 9 && flag === "Green") { flag = "Yellow"; h.message(`<S T="${T(at)}" S="Yellow" E="R1" />`); h.message(`<G T="${T(at)}" R="Race Control: Local yellow - Turn 2 - car stopped" C="" />`); }
        if (c.laps === 10 && flag === "Yellow") { flag = "Green"; h.message(`<S T="${T(at)}" S="Green" E="R1" />`); }
      }
    }
    for (const c of cars) if (c.pitOut !== undefined && c.pitOut <= sim) {
      c.pitOut = undefined;
      items += `<P C="${c.id}" D="1"><D P="N" PF="T" PT="24.0" PS="${c.stops}" /></P>`;
    }
    if (items) h.message(`<L T="${T(sim)}" Y="p">${items}</L>`);
    const leaderLaps = Math.max(...cars.map((c) => c.laps));
    h.message(`<C T="${T(sim)}" Y="L" C="${Math.max(0, raceLaps - leaderLaps)}" E="${Math.min(leaderLaps, raceLaps)}" />`);
    if (finished && (cars.every((c) => c.done) || sim > (leaderCross.get(raceLaps) ?? sim) + 150)) {
      h.message(`<S T="${T(sim)}" S="Ended" E="R1" />`);
      return;
    }
    await sleep(tickMs);
  }
}
