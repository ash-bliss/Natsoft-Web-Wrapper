import { runDemo } from "../src/demo";
import { LiveTiming } from "../src/timing";
const t = new LiveTiming();
const flags: string[] = [];
let pitSeen = false;
const ac = new AbortController();
await runDemo({
  status: () => {},
  message: (x) => {
    t.apply(x);
    if (flags[flags.length - 1] !== t.flag) flags.push(t.flag);
    if ([...t.cars.values()].some((c) => c.inPit)) pitSeen = true;
    if (t.flag === "Ended") ac.abort();
  },
}, ac.signal, 0, 15);
const s = t.snapshot("DEMO", "demo");
console.log("flags:", flags.join(" → "));
console.log("pit seen:", pitSeen, "| stops:", s.cars.filter((c) => c.stops).map((c) => `#${c.no}×${c.stops}`).join(" "));
console.log("race control:", s.raceControl.map((m) => m.text));
console.log("winner:", s.cars[0].no, s.cars[0].driver, "laps", s.cars[0].laps, "| best", s.best.lap?.toFixed(3), "#" + s.best.number);
console.log("clock:", JSON.stringify(s.clock));
process.exit(0);
