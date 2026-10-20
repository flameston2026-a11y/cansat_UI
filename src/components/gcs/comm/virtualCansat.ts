import { advance, createSim, simAssistOff, simSetTarget, snapshot, type SimState } from "../sim";
import {
  encodeAck,
  encodeCmd,
  encodeEvt,
  encodeExe,
  encodeLnd,
  encodeTlm,
  parseCmdLine,
  type Values,
} from "./protocol";

/** Spec v1.0 flight-state numbers 0 to 7 for the simulator's states. */
const SPEC_STATE: Record<string, number> = {
  BOOT: 0, STANDBY: 2, EJECTION: 4, PRIMARY_DESCENT: 5, CONTROLLED_DESCENT: 6, LANDED: 7, MISSION_COMPLETE: 7,
};

export const VIRTUAL_TEAM_ID = "2026-IN-SPACe-CAN-7USAT-020";

export type CmdReply = { ack: string; exe?: { line: string; delayMs: number } };

/**
 * A CanSat that exists only in software. It speaks the real protocol (telemetry
 * lines, $LND, $EVT, and ACK/EXE replies to $CMD), built from the flight
 * simulator. Use it to test the ground link end to end without hardware, and as
 * a worked example of what the flight software must send.
 */
export class VirtualCansat {
  private s: SimState;
  private acc = 0;
  private count = 0;
  private seenEvents = 0;
  private txOn = true;

  constructor(private seed = 11) {
    this.s = createSim(seed);
  }

  get transmitting() {
    return this.txOn;
  }

  /** Advance simulated time; returns the lines the radio would transmit. */
  step(dt: number): string[] {
    advance(this.s, dt);
    this.acc += dt;
    const out: string[] = [];
    while (this.acc >= 1) {
      this.acc -= 1;
      const f = snapshot(this.s);
      if (f.state === "MISSION_COMPLETE" && f.autoRestartIn !== null && f.autoRestartIn <= 0) {
        this.s = createSim(this.seed + this.count);
        this.seenEvents = 0;
        continue;
      }
      if (!this.txOn) continue;
      this.count++;
      const [h, m, sec] = f.gnss.utc.split(":").map(Number);
      const tlm: Values = {
        teamId: VIRTUAL_TEAM_ID,
        time: f.t,
        count: this.count,
        alt: f.altitude,
        press: f.baro.pressure * 100,
        temp: f.sht.temp,
        volt: f.ina.busV,
        gnssTime: h * 3600 + m * 60 + sec,
        lat: f.gnss.fix === "3D" ? f.gnss.lat : NaN,
        lon: f.gnss.fix === "3D" ? f.gnss.lon : NaN,
        gnssAlt: f.gnss.alt,
        sats: f.gnss.sats,
        ax: f.imu.ax,
        ay: f.imu.ay,
        az: f.imu.az,
        roll: f.imu.roll,
        pitch: f.imu.pitch,
        spin: f.imu.gz,
        state: SPEC_STATE[f.state] ?? 2,
        hum: f.sht.rh,
        curr: f.ina.currentMA,
      };
      out.push(encodeTlm(tlm));
      if (f.landing !== "IDLE") {
        out.push(
          encodeLnd({
            met: f.met,
            landing: f.landing,
            thrustPct: f.thrustPct,
            matchC: f.matchC,
            matchPsr: f.matchPsr,
            estE: f.posE,
            estN: f.posN,
            tilt: f.tiltCmd,
            band: f.band,
            vision: f.visionStatus,
            roll: f.imu.roll,
            pitch: f.imu.pitch,
            yaw: f.imu.yaw,
            tofMm: f.tof.mm ?? -1,
            arms: f.armsOpen,
            windS: f.windSpeed,
            windFrom: f.windFrom,
          }),
        );
      }
      while (this.seenEvents < f.events.length) {
        const e = f.events[this.seenEvents++];
        out.push(encodeEvt(e.t, e.label));
      }
    }
    return out;
  }

  /** Handle an uplink line. Returns the ACK now and an optional EXE later. */
  handle(line: string): CmdReply | null {
    const c = parseCmdLine(line);
    if (!c.ok) return null; // a real CanSat stays silent on garbage
    const known = ["CXON", "CXOFF", "CAL_IMU", "ZERO_ALT", "ZERO_ACC", "PING", "SERVO", "CHUTE", "SIM_EN", "SIM_ACT", "ASSIST_OFF", "SET_TGT"];
    if (!known.includes(c.wire)) return { ack: encodeAck(c.id, false, "UNKNOWN") };
    const ack = encodeAck(c.id, true);
    let ok = true;
    let reason: string | undefined;
    if (c.wire === "CXON") this.txOn = true;
    else if (c.wire === "CXOFF") this.txOn = false;
    else if (c.wire === "ASSIST_OFF") {
      const r = simAssistOff(this.s);
      ok = r.ok;
      reason = r.reason;
    } else if (c.wire === "SET_TGT") {
      const lat = Number(c.args[0]);
      const lon = Number(c.args[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        ok = false;
        reason = "BAD_ARGS";
      } else {
        const r = simSetTarget(this.s, lat, lon);
        ok = r.ok;
        reason = r.reason?.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 24);
      }
    }
    return { ack, exe: { line: encodeExe(c.id, ok, reason), delayMs: 500 + (c.id % 5) * 120 } };
  }
}

// re-exported for tests
export { encodeCmd };
