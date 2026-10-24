import { XNode, child, childrenNamed, int, num, parseXml, str } from "./xml";

export interface CarEntry {
  id: string;
  number: string;
  vehicle: string;
  drivers: Record<string, string>;
}

export interface CarState {
  id: string;
  position?: number;
  driverIndex: string;
  laps?: number;
  lastLap?: number;
  bestLap?: number;
  bestLapNo?: number;
  gap?: number;
  gapLaps?: number;
  interval?: number;
  intervalLaps?: number;
  s1?: number;
  s2?: number;
  s3?: number;
  bestS1?: number;
  bestS2?: number;
  bestS3?: number;
  speed?: number;
  inPit: boolean;
  pitStops?: number;
  lastPoint?: string;
  /** ms timestamps for highlights */
  positionChangedAt?: number;
  positionDelta?: number;
  lapCompletedAt?: number;
}

export interface RaceControlMessage {
  trackTime?: number;
  receivedAt: number;
  text: string;
}

/** What phones and overlays receive. Plain JSON, no Natsoft internals. */
export interface Snapshot {
  meeting: string;
  status: string;
  statusDetail?: string;
  updatedAt?: number;
  trackTime?: number;
  meetingName: string;
  category: string;
  trackName: string;
  trackCode: string;
  sessionName: string;
  sessionType: string;
  isRace: boolean;
  flag: string;
  clock: { type: string; remaining?: number; elapsed?: number; scheduledLaps: number };
  best: { lap?: number; carId?: string; number?: string; driver?: string; s1?: number; s2?: number; s3?: number };
  record?: { time: number; driver: string; vehicle: string };
  cars: Array<{
    id: string;
    pos?: number;
    no: string;
    driver: string;
    vehicle: string;
    laps?: number;
    last?: number;
    best?: number;
    bestLapNo?: number;
    gap?: number;
    gapLaps?: number;
    int?: number;
    intLaps?: number;
    s1?: number; s2?: number; s3?: number;
    bs1?: number; bs2?: number; bs3?: number;
    speed?: number;
    pit: boolean;
    stops?: number;
    posDelta?: number;
    posChangedAt?: number;
    lapAt?: number;
  }>;
  raceControl: RaceControlMessage[];
}

const positive = (v: number | undefined) => (v !== undefined && v > 0 ? v : undefined);
const titleCase = (s: string) => s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** The state of one Natsoft session, built from the <New> snapshot and the deltas that follow. */
export class LiveTiming {
  meetingName = "";
  category = "";
  trackName = "";
  trackCode = "";
  sessionName = "";
  sessionType = "";
  sessionCode = "";
  scheduledLaps = 0;
  record?: { time: number; driver: string; vehicle: string };
  flag = "";
  clockType = "";
  clockRemaining?: number;
  clockElapsed?: number;
  best: { lap?: number; carId?: string; s1?: number; s2?: number; s3?: number } = {};
  entries = new Map<string, CarEntry>();
  cars = new Map<string, CarState>();
  raceControl: RaceControlMessage[] = [];
  trackNow = 0;
  lastMessageAt?: number;
  messageCount = 0;
  parseFailures = 0;
  private inSnapshot = false;

  get hasSession() { return this.sessionName !== "" || this.cars.size > 0; }
  get isRace() { return this.clockType === "L" || /race/i.test(this.sessionType); }

  apply(xml: string, now = Date.now()) {
    this.lastMessageAt = now;
    this.messageCount++;
    const roots = parseXml(xml);
    if (roots.length === 0) { this.parseFailures++; return; }
    for (const r of roots) this.applyRoot(r, now);
  }

  private applyRoot(root: XNode, now: number) {
    const t = num(root, "T");
    if (t && t > 0) this.trackNow = t;
    switch (root.name) {
      case "New":
      case "Change":
      case "WaitCat": {
        const previous = this.sessionCode + "|" + this.sessionName;
        this.entries.clear();
        this.cars.clear();
        this.best = {};
        this.scheduledLaps = 0;
        this.inSnapshot = true;
        try { for (const c of root.children) this.applyChild(c, now); }
        finally { this.inSnapshot = false; }
        if (previous !== this.sessionCode + "|" + this.sessionName) this.raceControl = [];
        break;
      }
      default:
        this.applyChild(root, now);
    }
  }

  private applyChild(e: XNode, now: number) {
    switch (e.name) {
      case "M":
        this.meetingName = str(e, "D") ?? this.meetingName;
        this.category = str(e, "Y") ?? this.category;
        break;
      case "T":
        this.trackCode = str(e, "C") ?? this.trackCode;
        this.trackName = titleCase(str(e, "N") ?? this.trackName);
        break;
      case "E": {
        this.sessionCode = str(e, "C") ?? this.sessionCode;
        this.sessionName = str(e, "D") ?? this.sessionName;
        this.sessionType = str(e, "Y") ?? this.sessionType;
        this.scheduledLaps = int(e, "L") ?? this.scheduledLaps;
        const ri = num(e, "RI");
        if (ri && ri > 0) {
          this.record = { time: ri, driver: (str(e, "RC") ?? "").replace(/_/g, " "), vehicle: str(e, "RV") ?? "" };
        }
        break;
      }
      case "RL":
        for (const r of childrenNamed(e, "R")) {
          const id = str(r, "ID");
          if (!id) continue;
          const drivers: Record<string, string> = {};
          for (const v of childrenNamed(r, "V")) {
            drivers[str(v, "ID") ?? String(Object.keys(drivers).length + 1)] = (str(v, "N") ?? "").replace(/_/g, " ");
          }
          this.entries.set(id, { id, number: str(r, "N") ?? "", vehicle: str(r, "V") ?? "", drivers });
        }
        break;
      case "S":
      case "F": {
        const s = str(e, "S");
        if (s) this.flag = s;
        break;
      }
      case "C":
        this.clockRemaining = int(e, "C");
        this.clockElapsed = int(e, "E");
        this.clockType = str(e, "Y") ?? this.clockType;
        break;
      case "A": {
        // Before anyone sets a time Natsoft sends I="0" with no car: that's "no session best yet".
        const lap = num(e, "I");
        if (lap !== undefined) this.best.lap = lap > 0 ? lap : undefined;
        const car = str(e, "C");
        if (car !== undefined) this.best.carId = car === "" ? undefined : car;
        this.best.s1 = num(e, "S1") ?? this.best.s1;
        this.best.s2 = num(e, "S2") ?? this.best.s2;
        this.best.s3 = num(e, "S3") ?? this.best.s3;
        break;
      }
      case "L":
        for (const p of childrenNamed(e, "P")) this.applyCar(p, now);
        break;
      case "G": {
        const text = (str(e, "R") ?? "").trim();
        if (text && !this.inSnapshot) {
          this.raceControl.unshift({ trackTime: this.trackNow || undefined, receivedAt: now, text });
          if (this.raceControl.length > 100) this.raceControl.length = 100;
        }
        break;
      }
      // H heartbeat, OL other categories: ignored
    }
  }

  private applyCar(p: XNode, now: number) {
    const id = str(p, "C");
    if (!id) return;
    let c = this.cars.get(id);
    if (!c) { c = { id, driverIndex: "1", inPit: false }; this.cars.set(id, c); }

    const pos = int(p, "L");
    if (pos !== undefined) {
      if (c.position !== undefined && c.position !== pos && !this.inSnapshot) {
        c.positionDelta = c.position - pos;
        c.positionChangedAt = now;
      }
      c.position = pos;
    }
    const drv = str(p, "D");
    if (drv) c.driverIndex = drv;

    const d = child(p, "D");
    if (!d) return;
    const pit = str(d, "P");
    if (pit !== undefined) c.inPit = pit === "Y";
    const laps = int(d, "L");
    if (laps !== undefined) {
      if (c.laps !== undefined && laps > c.laps && !this.inSnapshot) c.lapCompletedAt = now;
      c.laps = laps;
    }
    c.lastLap = positive(num(d, "I")) ?? c.lastLap;
    c.bestLap = positive(num(d, "FI")) ?? c.bestLap;
    c.bestLapNo = int(d, "FL") ?? c.bestLapNo;
    if (d.attrs.GI !== undefined) c.gap = num(d, "GI");
    if (d.attrs.GNI !== undefined) c.interval = num(d, "GNI");
    if (d.attrs.GL !== undefined) c.gapLaps = int(d, "GL"); // "?" -> undefined
    if (d.attrs.GNL !== undefined) c.intervalLaps = int(d, "GNL");
    // A new S1 starts a new lap's sectors
    const s1 = num(d, "S1");
    if (s1 !== undefined) {
      c.s1 = s1;
      if (d.attrs.S2 === undefined) c.s2 = undefined;
      if (d.attrs.S3 === undefined) c.s3 = undefined;
    }
    c.s2 = num(d, "S2") ?? c.s2;
    c.s3 = num(d, "S3") ?? c.s3;
    c.bestS1 = positive(num(d, "FS1")) ?? c.bestS1;
    c.bestS2 = positive(num(d, "FS2")) ?? c.bestS2;
    c.bestS3 = positive(num(d, "FS3")) ?? c.bestS3;
    const sp = int(d, "SP");
    if (sp && sp > 0) c.speed = sp;
    c.pitStops = int(d, "PS") ?? c.pitStops;
    c.lastPoint = str(d, "LP") ?? c.lastPoint;
  }

  driverName(c: CarState): string {
    const e = this.entries.get(c.id);
    if (!e) return "";
    return e.drivers[c.driverIndex] ?? Object.entries(e.drivers).sort(([a], [b]) => a.localeCompare(b))[0]?.[1] ?? "";
  }

  sortedCars(): CarState[] {
    const numOf = (c: CarState) => parseInt(this.entries.get(c.id)?.number ?? "", 10) || 999;
    return [...this.cars.values()].sort((a, b) => {
      if (a.position !== undefined && b.position !== undefined && a.position !== b.position) return a.position - b.position;
      if (a.position !== undefined && b.position === undefined) return -1;
      if (a.position === undefined && b.position !== undefined) return 1;
      return numOf(a) - numOf(b);
    });
  }

  snapshot(meeting: string, status: string, statusDetail?: string): Snapshot {
    const bestCar = this.best.carId ? this.cars.get(this.best.carId) : undefined;
    return {
      meeting,
      status,
      statusDetail,
      updatedAt: this.lastMessageAt,
      trackTime: this.trackNow || undefined,
      meetingName: this.meetingName,
      category: this.category,
      trackName: this.trackName,
      trackCode: this.trackCode,
      sessionName: this.sessionName,
      sessionType: this.sessionType,
      isRace: this.isRace,
      flag: this.flag,
      clock: { type: this.clockType, remaining: this.clockRemaining, elapsed: this.clockElapsed, scheduledLaps: this.scheduledLaps },
      best: {
        ...this.best,
        number: this.best.carId ? this.entries.get(this.best.carId)?.number : undefined,
        driver: bestCar ? this.driverName(bestCar) : undefined,
      },
      record: this.record,
      cars: this.sortedCars().map((c) => {
        const e = this.entries.get(c.id);
        return {
          id: c.id, pos: c.position, no: e?.number ?? "", driver: this.driverName(c), vehicle: e?.vehicle ?? "",
          laps: c.laps, last: c.lastLap, best: c.bestLap, bestLapNo: c.bestLapNo,
          gap: c.gap, gapLaps: c.gapLaps, int: c.interval, intLaps: c.intervalLaps,
          s1: c.s1, s2: c.s2, s3: c.s3, bs1: c.bestS1, bs2: c.bestS2, bs3: c.bestS3,
          speed: c.speed, pit: c.inPit, stops: c.pitStops,
          posDelta: c.positionDelta, posChangedAt: c.positionChangedAt, lapAt: c.lapCompletedAt,
        };
      }),
      raceControl: this.raceControl.slice(0, 50),
    };
  }
}
