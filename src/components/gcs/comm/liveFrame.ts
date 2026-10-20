import {
  BAND_HEIGHTS,
  PIXEL_FACTOR,
  TARGET,
  bearingDeg,
  landingName,
  latLonToEnu,
  ringIndex,
  ringLabel,
  type LandingId,
} from "../mission";
import type { CansatFrame, CansatState, HealthItem, HistRow, MissionEventRec, TrackPt } from "../sim";
import { RULEBOOK_STATES, TLM_FIELDS, accelCell, csvCell, csvHeader, type Parsed, type Values } from "./protocol";

/**
 * Turns decoded packets into the CansatFrame the screens already draw.
 *
 * Rule: nothing is invented. A value the CanSat does not send is NaN (the UI
 * prints "—"), never a simulated number. Quantities that are computed here
 * (range, error, ground speed, descent rate, packet loss) come only from real
 * packets.
 */

const NAN = Number.NaN;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const num = (v: number | string | undefined): number => (typeof v === "number" ? v : NAN);
const LANDING_IDS: LandingId[] = ["IDLE", "L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"];
const CTRL = new Set<string>(["L3", "L4", "L5", "L6", "L7", "L8"]);

/** Map the flight-software state text sent by the CanSat to the UI state. CONFIRM names. */
export function mapState(text: string, landing: LandingId): CansatState {
  if (CTRL.has(landing)) return "CONTROLLED_DESCENT";
  if (landing === "L10") return "LANDED";
  let s = text.trim().toUpperCase();
  if (/^[0-7]$/.test(s)) s = RULEBOOK_STATES[Number(s)]; // rulebook numeric states 0..7
  if (s.includes("ROCKET_DEPLOY") || s.includes("AEROBREAK")) return s.includes("AEROBREAK") ? "PRIMARY_DESCENT" : "EJECTION";
  if (s.includes("COMPLETE")) return "MISSION_COMPLETE";
  if (s.includes("IMPACT") || s.includes("LAND")) return "LANDED";
  if (s.includes("CONTROLLED")) return "CONTROLLED_DESCENT";
  if (s.includes("EJECT") || s.includes("SEPAR")) return "EJECTION";
  if (s.includes("DESCENT") || s.includes("DROGUE") || s.includes("MAIN") || s.includes("PARACHUTE") || s.includes("DEPLOY"))
    return "PRIMARY_DESCENT";
  if (s.includes("BOOT")) return "BOOT";
  return "STANDBY";
}

/** Competition rule: transmission stops 90 minutes after launch detect. */
export const TX_SHUTDOWN_S = 90 * 60;

/** True once the flight-software state is past LAUNCH_PAD (numeric 3 to 7 or the matching names). */
function launched(text: string): boolean {
  let s = text.trim().toUpperCase();
  if (/^[0-7]$/.test(s)) s = RULEBOOK_STATES[Number(s)];
  return /ASCENT|ROCKET_DEPLOY|DESCENT|AEROBREAK|IMPACT|EJECT|SEPAR|LAND|DEPLOY/.test(s);
}

const isSeparated = (st: CansatState) => st === "EJECTION" || st === "PRIMARY_DESCENT" || st === "CONTROLLED_DESCENT";

type Rx = { rssi?: number; snr?: number; at: number };

export class LiveFrameBuilder {
  private tlm: Values | null = null;
  private lnd: Values | null = null;
  private tlmAt = 0;
  private lndAt = 0;

  private firstTime: number | null = null;
  private lastTime: number | null = null;
  private sepTime: number | null = null;
  private history: HistRow[] = [];
  private path: TrackPt[] = [];
  private events: MissionEventRec[] = [];
  private lastState: CansatState | null = null;
  private lastLanding: LandingId = "IDLE";

  private pad: [number, number] | null = null;
  private target = { lat: TARGET.lat, lon: TARGET.lon };

  // derived motion
  private altSamples: { t: number; a: number }[] = [];
  private lastFix: { t: number; e: number; n: number } | null = null;
  private groundSpeed = NAN;
  private course = NAN;
  private descentRate = NAN;

  // link
  private rssi = NAN;
  private snr = NAN;
  private received = 0;
  private lost = 0;
  private crc = 0;
  private parseErrors = 0;
  private lastCount: number | null = null;
  private lastRxAt = 0;
  private rate = NAN;
  private tlmRows: Values[] = [];
  private launchT: number | null = null; // time stamping at launch detect (first state past LAUNCH_PAD)

  reset() {
    Object.assign(this, new LiveFrameBuilder());
  }

  setTarget(lat: number, lon: number) {
    this.target = { lat, lon };
  }

  /** Count a rejected line (checksum or format) for the link statistics. */
  noteBad(kind: "crc" | "parse") {
    if (kind === "crc") this.crc++;
    else this.parseErrors++;
  }

  stats() {
    return { received: this.received, lost: this.lost, crc: this.crc, parseErrors: this.parseErrors };
  }

  snapshotFields() {
    return { tlm: this.tlm, lnd: this.lnd, tlmAt: this.tlmAt, lndAt: this.lndAt };
  }

  /** CSV text of every telemetry packet received, with a header row. */
  csv(): string {
    // spec v1.0 layout: the accelerometer is ONE column, "ax;ay;az;roll;pitch"
    const before = TLM_FIELDS.slice(0, 12);
    const after = TLM_FIELDS.slice(15);
    const head = [...before.map(csvHeader), "ACCELEROMETER (ax;ay;az m/s²;roll;pitch °)", ...after.map(csvHeader)];
    const rows = this.tlmRows.map((v) =>
      [...before.map((d) => csvCell(d, v[d.key])), accelCell(v), ...after.map((d) => csvCell(d, v[d.key]))].join(","),
    );
    return [head.join(","), ...rows].join("\r\n") + "\r\n";
  }

  /** Team ID from the latest packet (for the Flight_<TEAM_ID>.csv file name). */
  teamId(): string {
    const t = this.tlm?.teamId;
    return typeof t === "string" && t ? t : "";
  }

  ingest(p: Parsed, rx: Rx) {
    if (p.kind === "error") {
      this.noteBad(p.error.includes("checksum") ? "crc" : "parse");
      return;
    }
    if (rx.rssi !== undefined) this.rssi = rx.rssi;
    if (rx.snr !== undefined) this.snr = rx.snr;

    if (p.kind === "tlm") this.ingestTlm(p.values, p.raw, rx);
    else if (p.kind === "lnd") {
      this.lnd = p.values;
      this.lndAt = rx.at;
      const l = String(p.values.landing).toUpperCase() as LandingId;
      this.lastLanding = LANDING_IDS.includes(l) ? l : "IDLE";
      const met = num(p.values.met);
      if (this.tlm && Number.isFinite(met) && met >= 0 && this.sepTime === null) this.markSeparation(num(this.tlm.time) - met);
    } else if (p.kind === "evt") {
      this.addEvent(this.axisNow(), p.label);
    }
  }

  // ---- telemetry ------------------------------------------------------------
  private ingestTlm(v: Values, raw: string, rx: Rx) {
    const time = num(v.time);
    this.tlm = v;
    this.tlmAt = rx.at;
    this.received++;
    void raw;
    this.tlmRows.push(v);
    if (this.tlmRows.length > 20000) this.tlmRows.shift();

    // packet loss from gaps in PACKET COUNT
    const count = num(v.count);
    if (Number.isFinite(count)) {
      if (this.lastCount !== null && count > this.lastCount + 1) this.lost += count - this.lastCount - 1;
      this.lastCount = count;
    }
    if (this.lastRxAt > 0 && rx.at > this.lastRxAt) {
      const r = 1000 / (rx.at - this.lastRxAt);
      this.rate = Number.isFinite(this.rate) ? this.rate * 0.7 + r * 0.3 : r;
    }
    this.lastRxAt = rx.at;

    if (!Number.isFinite(time)) return;
    if (this.lastTime !== null && time < this.lastTime - 2) this.newFlight();
    this.lastTime = time;
    if (this.firstTime === null) this.firstTime = time;

    // state transitions -> events
    const landing = this.lastLanding;
    const st = mapState(String(v.state), landing);
    if (this.lastState !== null && st !== this.lastState) this.addEvent(this.axisNow(time), st.replace(/_/g, " "));
    if (isSeparated(st) && this.sepTime === null) this.markSeparation(time);
    this.lastState = st;
    if (this.launchT === null && launched(String(v.state))) this.launchT = time;

    // motion
    const alt = num(v.alt);
    if (Number.isFinite(alt)) {
      this.altSamples.push({ t: time, a: alt });
      if (this.altSamples.length > 4) this.altSamples.shift();
      if (this.altSamples.length >= 2) {
        const a = this.altSamples[0];
        const b = this.altSamples[this.altSamples.length - 1];
        if (b.t > a.t) this.descentRate = (a.a - b.a) / (b.t - a.t);
      }
    }
    const lat = num(v.lat);
    const lon = num(v.lon);
    const sats = num(v.sats);
    const hasFix = Number.isFinite(lat) && Number.isFinite(lon) && sats >= 4 && !(lat === 0 && lon === 0);
    if (hasFix) {
      const [e, n] = latLonToEnu(lat, lon);
      if (this.lastFix && time > this.lastFix.t) {
        const dt = time - this.lastFix.t;
        const sp = Math.hypot(e - this.lastFix.e, n - this.lastFix.n) / dt;
        this.groundSpeed = Number.isFinite(this.groundSpeed) ? this.groundSpeed * 0.6 + sp * 0.4 : sp;
        if (sp > 0.3) this.course = bearingDeg(e - this.lastFix.e, n - this.lastFix.n);
      }
      this.lastFix = { t: time, e, n };
      if (this.pad === null && this.sepTime === null && !isSeparated(st)) this.pad = [e, n];
      if (this.sepTime !== null) {
        this.path.push({ e, n, alt, t: time - this.sepTime, ctrl: CTRL.has(landing) || st === "CONTROLLED_DESCENT" });
        if (this.path.length > 1500) this.path.shift();
      }
    }

    // history row
    const axis = this.axisNow(time);
    const lnd = this.lnd && rx.at - this.lndAt < 5000 ? this.lnd : null;
    const [e, n] = hasFix ? latLonToEnu(lat, lon) : [NAN, NAN];
    const [tE, tN] = latLonToEnu(this.target.lat, this.target.lon);
    const err = hasFix ? Math.hypot(e - tE, n - tN) : NAN;
    const volt = num(v.volt);
    const curr = num(v.curr);
    const tof = lnd ? num(lnd.tofMm) : NAN;
    this.history.push({
      t: axis,
      alt,
      vref: NAN,
      vz: this.descentRate,
      gspeed: this.groundSpeed,
      errG: err,
      errV: lnd ? Math.hypot(num(lnd.estE), num(lnd.estN)) : NAN,
      miss: NAN,
      ax: num(v.ax),
      ay: num(v.ay),
      az: num(v.az),
      gx: num(v.gx),
      gy: num(v.gy),
      gz: num(v.spin),
      mx: num(v.mx),
      my: num(v.my),
      mz: num(v.mz),
      roll: lnd && Number.isFinite(num(lnd.roll)) ? num(lnd.roll) : num(v.roll),
      pitch: lnd && Number.isFinite(num(lnd.pitch)) ? num(lnd.pitch) : num(v.pitch),
      press: num(v.press) / 100,
      temp: num(v.temp),
      rh: num(v.hum),
      busV: volt,
      curr,
      pwr: volt * curr,
      tof: Number.isFinite(tof) && tof >= 0 ? tof : null,
      rssi: this.rssi,
      snr: this.snr,
      c: lnd ? num(lnd.matchC) : NAN,
      thrust: lnd ? num(lnd.thrustPct) : NAN,
    });
    if (this.history.length > 4000) this.history.shift();
  }

  /** Flight clock starts at separation: history, track and events restart there. */
  private markSeparation(time: number) {
    this.sepTime = time;
    this.history = [];
    this.path = [];
    this.events = [];
    this.addEvent(0, "SEPARATION");
  }

  private addEvent(t: number, label: string) {
    if (this.events.slice(-8).some((e) => e.label === label && Math.abs(e.t - t) <= 3)) return;
    this.events.push({ t, label });
    if (this.events.length > 60) this.events.shift();
  }

  /** The CanSat restarted (its clock went backwards): begin a fresh flight view. */
  private newFlight() {
    this.firstTime = null;
    this.launchT = null;
    this.sepTime = null;
    this.history = [];
    this.path = [];
    this.events = [];
    this.lastState = null;
    this.lastLanding = "IDLE";
    this.lnd = null;
    this.pad = null;
    this.altSamples = [];
    this.lastFix = null;
    this.groundSpeed = NAN;
    this.course = NAN;
    this.descentRate = NAN;
    this.lastCount = null;
  }

  private axisNow(time?: number): number {
    const t = time ?? num(this.tlm?.time);
    if (!Number.isFinite(t)) return 0;
    if (this.sepTime !== null) return Math.round(t - this.sepTime);
    return Math.round(t - (this.firstTime ?? t));
  }

  // ---- frame -------------------------------------------------------------------
  frame(nowMs: number): CansatFrame {
    const v = this.tlm ?? {};
    const lnd = this.lnd && nowMs - this.lndAt < 8000 ? this.lnd : null;
    const landing: LandingId = lnd ? this.lastLanding : "IDLE";
    const state = this.tlm ? mapState(String(v.state ?? ""), landing) : "BOOT";
    const time = num(v.time);
    const met = this.sepTime !== null && Number.isFinite(time) ? time - this.sepTime : -1;

    const alt = num(v.alt);
    const lat = num(v.lat);
    const lon = num(v.lon);
    const sats = num(v.sats);
    const fixOk = Number.isFinite(lat) && Number.isFinite(lon) && sats >= 4 && !(lat === 0 && lon === 0);
    const [e, n] = fixOk ? latLonToEnu(lat, lon) : [NAN, NAN];
    const [tE, tN] = latLonToEnu(this.target.lat, this.target.lon);
    const posE = e - tE;
    const posN = n - tN;
    const range = Math.hypot(posE, posN);
    const ring = Number.isFinite(range) ? ringIndex(range) : 0;

    const volt = num(v.volt);
    const curr = num(v.curr);
    const ageS = this.tlmAt ? (nowMs - this.tlmAt) / 1000 : Infinity;
    const lossPct = this.received + this.lost > 0 ? (this.lost / (this.received + this.lost)) * 100 : 0;
    const linkQuality = Number.isFinite(this.snr)
      ? clamp(((this.snr + 20) / 35) * 100, 0, 100)
      : clamp(100 - lossPct * 4, 0, 100);

    const arms = lnd ? num(lnd.arms) : 0;
    const thrustPct = lnd ? num(lnd.thrustPct) : 0;
    const roll = lnd && Number.isFinite(num(lnd.roll)) ? num(lnd.roll) : v ? num(v.roll) : NAN;
    const pitch = lnd && Number.isFinite(num(lnd.pitch)) ? num(lnd.pitch) : v ? num(v.pitch) : NAN;
    const bandIdx = lnd ? num(lnd.band) : 0;
    const vision = lnd ? String(lnd.vision).toUpperCase() : "OFF";
    const visionStatus: CansatFrame["visionStatus"] =
      vision === "LOCKED" || vision === "SEARCH" || vision === "ENDED" ? vision : "OFF";
    const windS = lnd ? num(lnd.windS) : NAN;
    const windFrom = lnd ? num(lnd.windFrom) : NAN;

    const tilt = Number.isFinite(roll) && Number.isFinite(pitch) ? Math.hypot(roll, pitch) : NAN;
    const stability: CansatFrame["imu"]["stability"] = tilt > 25 ? "UNSTABLE" : tilt > 12 ? "SWAYING" : "STABLE";

    const utc = Number.isFinite(num(v.gnssTime))
      ? new Date(num(v.gnssTime) * 1000).toISOString().slice(11, 19)
      : "—";
    const gnss: CansatFrame["gnss"] = {
      lat,
      lon,
      alt: num(v.gnssAlt),
      speed: this.groundSpeed,
      sats,
      fix: fixOk ? "3D" : "NO FIX",
      hdop: NAN,
      utc,
    };

    const health: HealthItem[] = [
      {
        name: "Telemetry link",
        status: ageS > 5 ? "FAIL" : ageS > 3 ? "WARN" : "OK",
        detail: Number.isFinite(ageS) ? `last packet ${ageS.toFixed(1)} s ago` : "no packets yet",
      },
      { name: "Barometer", status: Number.isFinite(alt) ? "OK" : "OFF", detail: Number.isFinite(alt) ? `${(num(v.press) / 100).toFixed(1)} hPa` : "no data" },
      { name: "GNSS", status: fixOk ? "OK" : "WARN", detail: fixOk ? `3D · ${sats} sats` : "NO FIX" },
      { name: "IMU (accel)", status: Number.isFinite(num(v.ax)) ? "OK" : "OFF", detail: Number.isFinite(num(v.ax)) ? `${num(v.az).toFixed(2)} m/s² Z` : "no data" },
      { name: "Power bus", status: !Number.isFinite(volt) ? "OFF" : volt < 7 ? "WARN" : "OK", detail: Number.isFinite(volt) ? `${volt.toFixed(2)} V · ${curr.toFixed(0)} mA` : "no data" },
      { name: "Temp / humidity", status: Number.isFinite(num(v.temp)) ? "OK" : "OFF", detail: Number.isFinite(num(v.temp)) ? `${num(v.temp).toFixed(1)} °C` : "no data" },
      { name: "Landing-logic data", status: lnd ? "OK" : "OFF", detail: lnd ? `${landing} · ${landingName(landing)}` : "no $LND packets" },
    ];

    const faults: string[] = [];
    if (Number.isFinite(this.snr) && this.snr < 2) faults.push("WEAK LINK");

    const pad = this.pad ?? [NAN, NAN];
    return {
      state,
      landing,
      landingName: landingName(landing),
      t: Number.isFinite(time) ? time : 0,
      met,
      altitude: alt,
      descentRate: this.descentRate,
      vRef: NAN,
      groundSpeed: this.groundSpeed,
      speed3d: Math.hypot(this.groundSpeed, this.descentRate),
      course: this.course,
      lat,
      lon,
      posE,
      posN,
      rangeToTarget: range,
      slantToTarget: Math.hypot(range, alt),
      azimuthToTarget: Number.isFinite(range) ? bearingDeg(-posE, -posN) : NAN,
      errGnss: range,
      errVision: lnd ? Math.hypot(num(lnd.estE), num(lnd.estN)) : NAN,
      impactE: NAN,
      impactN: NAN,
      impactMiss: NAN,
      ring,
      ringText: Number.isFinite(range) ? ringLabel(ring) : "—",
      windSpeed: windS,
      windFrom,
      tRem: NAN,
      vDesGround: NAN,
      vAirCmd: NAN,
      vRelMax: NAN,
      reach: NAN,
      reachable: false,
      tiltCmd: lnd ? num(lnd.tilt) : NAN,
      band: Number.isFinite(bandIdx) ? bandIdx : 0,
      bandHeight: bandIdx > 0 ? (BAND_HEIGHTS[bandIdx - 1] ?? NAN) : 0,
      pixelSize: bandIdx > 0 ? PIXEL_FACTOR * (BAND_HEIGHTS[bandIdx - 1] ?? NAN) : NAN,
      visionStatus,
      matchC: lnd ? num(lnd.matchC) : NAN,
      matchPsr: lnd ? num(lnd.matchPsr) : NAN,
      fixesAccepted: 0,
      fixesRejected: 0,
      lastFixAge: NAN,
      cameraOn: CTRL.has(landing),
      thrustN: NAN,
      thrustPct: Number.isFinite(thrustPct) ? thrustPct : 0,
      motors: [0, 1, 2, 3].map(() => (Number.isFinite(thrustPct) ? thrustPct : 0)),
      arms: [0, 1, 2, 3].map((i) => (Number.isFinite(arms) && i < arms ? 90 : 0)),
      armsOpen: Number.isFinite(arms) ? arms : 0,
      interlocks: [],
      faults,
      imu: {
        ax: num(v.ax),
        ay: num(v.ay),
        az: num(v.az),
        gx: NAN,
        gy: NAN,
        gz: num(v.spin),
        mx: NAN,
        my: NAN,
        mz: NAN,
        roll,
        pitch,
        yaw: lnd ? num(lnd.yaw) : NAN,
        stability,
      },
      baro: { pressure: num(v.press) / 100, altitude: alt, vspeed: -this.descentRate },
      sht: { temp: num(v.temp), rh: num(v.hum) },
      ina: { busV: volt, currentMA: curr, powerMW: volt * curr },
      gnss,
      tof: {
        mm: lnd && Number.isFinite(num(lnd.tofMm)) && num(lnd.tofMm) >= 0 ? num(lnd.tofMm) : null,
        valid: !!lnd && num(lnd.tofMm) >= 0,
      },
      rssi: this.rssi,
      snr: this.snr,
      linkQuality,
      packetCount: this.received,
      packetsLost: this.lost,
      crcErrors: this.crc,
      updateRate: this.rate,
      slantFromGs: NAN,
      lastPacketAt: this.tlmAt,
      health,
      history: [...this.history],
      path: [...this.path],
      passivePath: [],
      events: [...this.events],
      padE: pad[0],
      padN: pad[1],
      targetE: tE,
      targetN: tN,
      targetLat: this.target.lat,
      targetLon: this.target.lon,
      propellers: arms >= 4 ? "DEPLOYED" : arms > 0 ? "DEPLOYING" : "STOWED",
      autoRestartIn: null,
      txShutdownIn:
        this.launchT !== null && this.lastTime !== null ? Math.max(0, TX_SHUTDOWN_S - (this.lastTime - this.launchT)) : null,
    };
  }

  /** Where the target is in the ENU frame (used by callers that need it). */
  targetEnu(): [number, number] {
    return latLonToEnu(this.target.lat, this.target.lon);
  }
}

