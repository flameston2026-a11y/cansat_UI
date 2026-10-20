// Pure flight simulator for the CanSat landing logic (no React here, so it
// can be tested on its own). It follows the Logic Spec: parachute fall from
// 1000 m, arms at 700 m, propellers + camera at 600 m, image fixes against
// per-band reference images, predicted-impact-point guidance, flare, touchdown.
//
// Positions are East/North metres in a frame whose origin is the ORIGINAL
// target (mission.ts TARGET). The pad is a derived point inside the 1 km zone.

import {
  BAND_HEIGHTS,
  FLAPS_ALT,
  H_VIS_MIN,
  PARAMS,
  PIXEL_FACTOR,
  PROP_ALT,
  SEPARATION_ALT,
  bandFor,
  bearingDeg,
  enuToLatLon,
  landingName,
  latLonToEnu,
  ringIndex,
  ringLabel,
  type LandingId,
  type LatLon,
  type Vec,
} from "./mission";

export type CansatState =
  | "BOOT"
  | "STANDBY"
  | "EJECTION"
  | "PRIMARY_DESCENT"
  | "CONTROLLED_DESCENT"
  | "LANDED"
  | "MISSION_COMPLETE";

export const CANSAT_STATES: CansatState[] = [
  "BOOT",
  "STANDBY",
  "EJECTION",
  "PRIMARY_DESCENT",
  "CONTROLLED_DESCENT",
  "LANDED",
  "MISSION_COMPLETE",
];

export type Sample = { t: number; v: number };

/** One row of flight history (one per simulated second after separation). */
export type HistRow = {
  t: number;
  alt: number;
  vref: number;
  vz: number;
  gspeed: number;
  errG: number;
  errV: number;
  miss: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
  mx: number;
  my: number;
  mz: number;
  roll: number;
  pitch: number;
  press: number;
  temp: number;
  rh: number;
  busV: number;
  curr: number;
  pwr: number;
  tof: number | null;
  rssi: number;
  snr: number;
  c: number;
  thrust: number;
};

export type TrackPt = { e: number; n: number; alt: number; t: number; ctrl: boolean };
export type MissionEventRec = { t: number; label: string };
export type HealthItem = {
  name: string;
  status: "OK" | "WARN" | "FAIL" | "OFF";
  detail: string;
};

export type CansatFrame = {
  state: CansatState;
  landing: LandingId;
  landingName: string;
  t: number; // simulated seconds since start
  met: number; // seconds since separation (negative before)
  // kinematics
  altitude: number;
  descentRate: number; // m/s, positive downwards
  vRef: number;
  groundSpeed: number;
  speed3d: number;
  course: number; // deg
  // position (GNSS) and error
  lat: number;
  lon: number;
  posE: number; // m relative to target
  posN: number;
  rangeToTarget: number; // horizontal, m (GNSS)
  slantToTarget: number;
  azimuthToTarget: number; // deg
  errGnss: number;
  errVision: number;
  impactE: number;
  impactN: number;
  impactMiss: number;
  ring: number;
  ringText: string;
  // guidance
  windSpeed: number;
  windFrom: number; // deg, direction the wind blows from
  tRem: number;
  vDesGround: number;
  vAirCmd: number;
  vRelMax: number;
  reach: number;
  reachable: boolean;
  tiltCmd: number;
  // vision
  band: number;
  bandHeight: number;
  pixelSize: number;
  visionStatus: "OFF" | "SEARCH" | "LOCKED" | "ENDED";
  matchC: number;
  matchPsr: number;
  fixesAccepted: number;
  fixesRejected: number;
  lastFixAge: number;
  cameraOn: boolean;
  // actuators
  thrustN: number;
  thrustPct: number;
  motors: number[];
  arms: number[]; // deployment angle 0..90 deg
  armsOpen: number;
  interlocks: { label: string; ok: boolean }[];
  faults: string[];
  // sensors
  imu: {
    ax: number;
    ay: number;
    az: number;
    gx: number;
    gy: number;
    gz: number;
    mx: number;
    my: number;
    mz: number;
    roll: number;
    pitch: number;
    yaw: number;
    stability: "STABLE" | "SWAYING" | "UNSTABLE";
  };
  baro: { pressure: number; altitude: number; vspeed: number };
  sht: { temp: number; rh: number };
  ina: { busV: number; currentMA: number; powerMW: number };
  gnss: {
    lat: number;
    lon: number;
    alt: number;
    speed: number;
    sats: number;
    fix: "3D" | "NO FIX";
    hdop: number;
    utc: string;
  };
  tof: { mm: number | null; valid: boolean };
  // link
  rssi: number;
  snr: number;
  linkQuality: number;
  packetCount: number;
  packetsLost: number;
  crcErrors: number;
  updateRate: number;
  slantFromGs: number;
  lastPacketAt: number; // wall clock ms
  health: HealthItem[];
  // history
  history: HistRow[];
  path: TrackPt[];
  passivePath: TrackPt[];
  events: MissionEventRec[];
  padE: number;
  padN: number;
  targetE: number;
  targetN: number;
  targetLat: number;
  targetLon: number;
  propellers: "STOWED" | "DEPLOYING" | "DEPLOYED";
  autoRestartIn: number | null;
  /** seconds until the competition's automatic transmission stop (90 min after launch detect); null before launch */
  txShutdownIn: number | null;
};

// ---- Random helpers ------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const norm2 = (v: Vec) => Math.hypot(v[0], v[1]);
const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

// ---- Simulation state ----------------------------------------------------
export type SimState = {
  rnd: () => number;
  t: number;
  sepT: number | null;
  landing: LandingId;
  state: CansatState;
  tLanding: number; // time entered current landing state
  pos: Vec;
  vel: Vec;
  h: number;
  vz: number;
  gust: Vec;
  windMean: Vec;
  forecast: Vec;
  tgt: Vec;
  pad: Vec;
  ang: Vec; // horizontal force from tilt, N
  est: Vec; // position estimate relative to target
  west: Vec;
  Tcur: number;
  armProg: number[];
  roll: number;
  pitch: number;
  yaw: number;
  gx: number;
  gy: number;
  gz: number;
  swayPhase: number;
  gnssRel: Vec;
  gnssBias: Vec;
  gnssLostUntil: number;
  fixTimer: number;
  lastFixT: number;
  accepted: number;
  rejected: number;
  matchC: number;
  matchPsr: number;
  visionEnded: boolean;
  visionDegraded: boolean;
  touchHold: number;
  landedT: number | null;
  forcePassive: boolean;
  shock: number;
  vDesGround: number;
  vAirCmd: number;
  vRelMax: number;
  reach: number;
  tRem: number;
  tiltCmd: number;
  histTimer: number;
  packetTimer: number;
  packetCount: number;
  packetsLost: number;
  crcErrors: number;
  history: HistRow[];
  path: TrackPt[];
  passivePath: TrackPt[];
  events: MissionEventRec[];
  lastRowT: number;
};

const T_SEP = 3; // seconds of standby before separation

export function createSim(seed = 7): SimState {
  const rnd = mulberry32(seed);
  const forecast: Vec = [2.7, 1.0]; // forecast mean wind, m/s (blowing towards E, N)
  const pad: Vec = [-forecast[0] * 200, -forecast[1] * 200];
  const s: SimState = {
    rnd,
    t: 0,
    sepT: null,
    landing: "IDLE",
    state: "STANDBY",
    tLanding: 0,
    pos: [pad[0], pad[1]],
    vel: [0, 0],
    h: SEPARATION_ALT,
    vz: 0,
    gust: [0, 0],
    windMean: [3.0, 1.2], // true wind differs from the forecast on purpose
    forecast,
    tgt: [0, 0],
    pad,
    ang: [0, 0],
    est: [pad[0], pad[1]],
    west: [0, 0],
    Tcur: 0,
    armProg: [0, 0, 0, 0],
    roll: 0,
    pitch: 0,
    yaw: 40,
    gx: 0,
    gy: 0,
    gz: 0,
    swayPhase: rnd() * 6,
    gnssRel: [pad[0], pad[1]],
    gnssBias: [0.6, -0.4],
    gnssLostUntil: 0,
    fixTimer: 0,
    lastFixT: -99,
    accepted: 0,
    rejected: 0,
    matchC: 0,
    matchPsr: 0,
    visionEnded: false,
    visionDegraded: false,
    touchHold: 0,
    landedT: null,
    forcePassive: false,
    shock: 0,
    vDesGround: 0,
    vAirCmd: 0,
    vRelMax: 0,
    reach: 0,
    tRem: 0,
    tiltCmd: 0,
    histTimer: 0,
    packetTimer: 0,
    packetCount: 0,
    packetsLost: 0,
    crcErrors: 0,
    history: [],
    path: [],
    passivePath: [],
    events: [],
    lastRowT: -99,
  };
  s.passivePath = predictPassive(s);
  return s;
}

function gauss(s: SimState): number {
  const u = Math.max(1e-9, s.rnd());
  const v = s.rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function windAt(s: SimState, h: number): Vec {
  const k = 1 + 0.3 * (h / 1000 - 0.5);
  return [s.windMean[0] * k + s.gust[0], s.windMean[1] * k + s.gust[1]];
}

/** Uncontrolled drift under the forecast wind (what the GS shows as the plan). */
function predictPassive(s: SimState): TrackPt[] {
  const kv = (PARAMS.M * PARAMS.G) / PARAMS.VT ** 2;
  const pts: TrackPt[] = [];
  let pos: Vec = [s.pad[0], s.pad[1]];
  let vel: Vec = [s.forecast[0], s.forecast[1]];
  let h = SEPARATION_ALT;
  let vz = PARAMS.VT;
  let t = 0;
  const dt = 0.5;
  while (h > 0 && t < 600) {
    const k = 1 + 0.3 * (h / 1000 - 0.5);
    const w: Vec = [s.forecast[0] * k, s.forecast[1] * k];
    const rel: Vec = [vel[0] - w[0], vel[1] - w[1]];
    const rn = norm2(rel);
    vel = [vel[0] + (-PARAMS.K_H * rn * rel[0] * dt) / PARAMS.M, vel[1] + (-PARAMS.K_H * rn * rel[1] * dt) / PARAMS.M];
    pos = [pos[0] + vel[0] * dt, pos[1] + vel[1] * dt];
    vz = Math.max(0.2, vz + (PARAMS.G - kv * vz * vz) * dt);
    h -= vz * dt;
    t += dt;
    if (Math.round(t * 2) % 10 === 0) pts.push({ e: pos[0], n: pos[1], alt: Math.max(0, h), t, ctrl: false });
  }
  pts.push({ e: pos[0], n: pos[1], alt: 0, t, ctrl: false });
  return pts;
}

function addEvent(s: SimState, label: string) {
  const t = s.sepT === null ? 0 : s.t - s.sepT;
  s.events.push({ t, label });
}

function setLanding(s: SimState, id: LandingId, state?: CansatState) {
  s.landing = id;
  s.tLanding = s.t;
  if (state) s.state = state;
}

function vRefAt(h: number, landing: LandingId): number {
  const x = clamp((PROP_ALT - h) / (PROP_ALT - PARAMS.H_FLARE), 0, 1);
  const base = PARAMS.V0 - (PARAMS.V0 - PARAMS.V_END) * x * x;
  return landing === "L7" || landing === "L8" ? Math.min(base, PARAMS.V_TOUCH) : base;
}

function isControlled(l: LandingId) {
  return l === "L3" || l === "L4" || l === "L5" || l === "L6" || l === "L7" || l === "L8";
}

function doFix(s: SimState) {
  const rel: Vec = [s.pos[0] - s.tgt[0], s.pos[1] - s.tgt[1]];
  // GNSS fix (1 Hz), with occasional dropouts
  if (s.t >= s.gnssLostUntil) {
    if (s.rnd() < 0.012) s.gnssLostUntil = s.t + 2 + s.rnd() * 3;
    else s.gnssRel = [rel[0] + s.gnssBias[0] + gauss(s) * 2.2, rel[1] + s.gnssBias[1] + gauss(s) * 2.2];
  }
  const gnssOk = s.t >= s.gnssLostUntil;

  const visionActive = (s.landing === "L4" || s.landing === "L5") && s.h >= H_VIS_MIN && s.sepT !== null;
  let visionAccepted = false;
  if (visionActive) {
    const bad = s.rnd() < 0.06;
    const c = bad
      ? 0.12 + s.rnd() * 0.22
      : clamp(0.72 + 0.1 * Math.sin(s.t / 9) + gauss(s) * 0.06, 0.1, 0.95);
    const psr = 1 + c * 1.6 + gauss(s) * 0.08;
    s.matchC = c;
    s.matchPsr = psr;
    if (c >= PARAMS.C_MIN && psr >= PARAMS.PSR_MIN) {
      const sigma = Math.max(1, 2 - c) * PIXEL_FACTOR * s.h;
      const z: Vec = [rel[0] + gauss(s) * sigma, rel[1] + gauss(s) * sigma];
      const k = 0.6 * c;
      s.est = [s.est[0] + k * (z[0] - s.est[0]), s.est[1] + k * (z[1] - s.est[1])];
      s.accepted += 1;
      s.lastFixT = s.t;
      visionAccepted = true;
    } else {
      s.rejected += 1;
    }
  }
  if (gnssOk) {
    const k = visionAccepted ? 0.1 : s.sepT === null ? 1 : 0.3;
    s.est = [s.est[0] + k * (s.gnssRel[0] - s.est[0]), s.est[1] + k * (s.gnssRel[1] - s.est[1])];
  }
}

export function stepSim(s: SimState, dt: number) {
  const P = PARAMS;
  s.t += dt;
  const kv = (P.M * P.G) / P.VT ** 2;

  // gust (Ornstein-Uhlenbeck)
  const dec = Math.exp(-dt / 6);
  s.gust = [
    s.gust[0] * dec + gauss(s) * 0.35 * Math.sqrt(dt),
    s.gust[1] * dec + gauss(s) * 0.35 * Math.sqrt(dt),
  ];

  // ---- Pre-separation: carried by the rocket --------------------------------
  if (s.sepT === null) {
    s.fixTimer += dt;
    if (s.fixTimer >= 1) {
      s.fixTimer -= 1;
      doFix(s);
    }
    packetTick(s, dt);
    if (s.t >= T_SEP) {
      s.sepT = s.t;
      s.vz = 14; // ejection speed, decays under the parachute
      s.vel = [s.windMean[0] * 0.8, s.windMean[1] * 0.8];
      s.shock = 0.3;
      setLanding(s, "L0", "EJECTION");
      addEvent(s, "SEPARATION");
    }
    return;
  }

  const sep = s.sepT;
  if (s.state === "EJECTION" && s.t - sep > 2.5) s.state = "PRIMARY_DESCENT";
  if (s.shock > 0) s.shock = Math.max(0, s.shock - dt);

  // ---- Vertical dynamics -----------------------------------------------------
  const ctrl = isControlled(s.landing) && !s.forcePassive;
  const vref = vRefAt(s.h, s.landing);
  let Tcmd = 0;
  if (ctrl) {
    const tff = Math.max(0, P.M * P.G * (1 - (vref / P.VT) ** 2));
    Tcmd = clamp(tff + 3.0 * (s.vz - vref), 0, P.T_MAX);
    if (s.landing === "L3") Tcmd *= clamp((s.t - s.tLanding) / 3, 0, 1);
  }
  const slew = (s.landing === "L9" ? 1.7 : 1) * P.THRUST_SLEW * dt;
  s.Tcur += clamp(Tcmd - s.Tcur, -slew, slew);
  if (s.landing === "L10") s.Tcur = 0;

  const onGround = s.h <= 0;
  if (!onGround) {
    const az = P.G - (kv * s.vz * s.vz + s.Tcur) / P.M;
    s.vz = Math.max(0.2, s.vz + az * dt);
    s.h -= s.vz * dt;
    if (s.h <= 0) {
      s.h = 0;
      s.vz = 0;
      s.shock = 0.3;
    }
  } else {
    s.vz = 0;
  }

  // ---- Fixes ------------------------------------------------------------------
  s.fixTimer += dt;
  if (s.fixTimer >= 1) {
    s.fixTimer -= 1;
    doFix(s);
  }
  // dead-reckoning between fixes
  s.est = [s.est[0] + s.vel[0] * dt, s.est[1] + s.vel[1] * dt];

  // ---- Guidance (predicted impact point) -----------------------------------------
  let Fh: Vec = [0, 0];
  const rel: Vec = [s.pos[0] - s.tgt[0], s.pos[1] - s.tgt[1]];
  const tRem = Math.max(s.h / Math.max(s.vz, 1), 10);
  s.tRem = tRem;
  const fn = norm2(s.ang);
  const vrelE: Vec = fn > 1e-6 ? [(s.ang[0] / fn) * Math.sqrt(fn / P.K_H), (s.ang[1] / fn) * Math.sqrt(fn / P.K_H)] : [0, 0];
  const wk = Math.min(1, dt / 2);
  s.west = [s.west[0] + wk * (s.vel[0] - vrelE[0] - s.west[0]), s.west[1] + wk * (s.vel[1] - vrelE[1] - s.west[1])];

  const tilt = rad(P.TILT_MAX_DEG);
  const fMax = Math.min(Math.tan(tilt) * Math.max(s.Tcur, 0.5 * P.M * P.G), P.T_MAX * Math.sin(tilt));
  s.vRelMax = Math.sqrt(fMax / P.K_H);
  s.reach = s.vRelMax * tRem;

  if (ctrl && (s.landing === "L4" || s.landing === "L5" || s.landing === "L6")) {
    let vdes: Vec = [-s.est[0] / tRem, -s.est[1] / tRem];
    const impact: Vec = [s.est[0] + s.west[0] * tRem, s.est[1] + s.west[1] * tRem];
    const db = Math.max(PIXEL_FACTOR * s.h, 10);
    if (norm2(impact) < db) vdes = [s.west[0], s.west[1]];
    let vair: Vec = [vdes[0] - s.west[0], vdes[1] - s.west[1]];
    const n = norm2(vair);
    if (n > s.vRelMax && n > 0) vair = [(vair[0] / n) * s.vRelMax, (vair[1] / n) * s.vRelMax];
    const na = norm2(vair);
    Fh = [P.K_H * na * vair[0] + P.M * (vdes[0] - s.vel[0]), P.K_H * na * vair[1] + P.M * (vdes[1] - s.vel[1])];
    const lim = s.vRelMax * s.vRelMax * P.K_H;
    const nf = norm2(Fh);
    if (nf > lim && nf > 0) Fh = [(Fh[0] / nf) * lim, (Fh[1] / nf) * lim];
    s.vDesGround = norm2(vdes);
    s.vAirCmd = na;
    s.tiltCmd = deg(Math.atan2(norm2(Fh), Math.max(s.Tcur, 3)));
  } else {
    s.vDesGround = 0;
    s.vAirCmd = 0;
    s.tiltCmd = 0;
  }
  const tk = Math.min(1, dt / P.TAU);
  s.ang = [s.ang[0] + (Fh[0] - s.ang[0]) * tk, s.ang[1] + (Fh[1] - s.ang[1]) * tk];

  // ---- Horizontal dynamics (parachute couples the body to the air) --------------
  const wl = windAt(s, s.h);
  const relv: Vec = [s.vel[0] - wl[0], s.vel[1] - wl[1]];
  const rn = norm2(relv);
  if (!onGround) {
    s.vel = [
      s.vel[0] + ((s.ang[0] - P.K_H * rn * relv[0]) / P.M) * dt,
      s.vel[1] + ((s.ang[1] - P.K_H * rn * relv[1]) / P.M) * dt,
    ];
    s.pos = [s.pos[0] + s.vel[0] * dt, s.pos[1] + s.vel[1] * dt];
  } else {
    s.vel = [0, 0];
  }

  // ---- Attitude (for IMU / indicator) -------------------------------------------
  const tref = Math.max(s.Tcur, 3);
  const amp = (ctrl ? 1.1 : 3.4) * (1 + 0.4 * norm2(s.gust));
  s.swayPhase += (2 * Math.PI * dt) / 3.1;
  const swayR = onGround ? 0 : amp * Math.sin(s.swayPhase);
  const swayP = onGround ? 0 : 0.7 * amp * Math.sin(s.swayPhase * 0.83 + 1);
  const newRoll = deg(Math.atan2(s.ang[0], tref)) + swayR;
  const newPitch = deg(Math.atan2(s.ang[1], tref)) + swayP;
  const newYaw = s.yaw + (-0.15 * (s.yaw - 40) * dt + gauss(s) * 0.7 * Math.sqrt(dt));
  if (dt > 1e-6) {
    s.gx = (newRoll - s.roll) / dt;
    s.gy = (newPitch - s.pitch) / dt;
    s.gz = (newYaw - s.yaw) / dt;
  }
  s.roll = newRoll;
  s.pitch = newPitch;
  s.yaw = newYaw;

  // ---- Landing state machine -------------------------------------------------------
  const tin = s.t - s.tLanding;
  const allOpen = s.armProg.every((p) => p >= 1);
  if (s.forcePassive && isControlled(s.landing)) {
    setLanding(s, "L9");
    addEvent(s, "ASSIST OFF · PASSIVE SAFE");
  }
  if (s.landing === "L1" || s.landing === "L2") {
    s.armProg = s.armProg.map((p, i) => Math.min(1, p + dt / (3.2 + 0.5 * i)));
  }
  switch (s.landing) {
    case "L0":
      if (s.h <= FLAPS_ALT) {
        setLanding(s, "L1");
        addEvent(s, "FLAPS OPEN");
      }
      break;
    case "L1":
      if (allOpen && s.h <= 650 && tin > 0.5) {
        setLanding(s, "L2");
        addEvent(s, "ARMS LOCKED");
      } else if (s.h <= 500 && !allOpen) {
        setLanding(s, "L9");
        addEvent(s, "ARM FAULT · PASSIVE SAFE");
      }
      break;
    case "L2":
      if (s.h <= PROP_ALT) {
        setLanding(s, "L3", "CONTROLLED_DESCENT");
        addEvent(s, "PROPS + CAMERA ON");
      }
      break;
    case "L3":
      if (tin >= 3 && Math.abs(s.roll) < 8 && Math.abs(s.pitch) < 8) setLanding(s, "L4");
      break;
    case "L4":
      if (s.accepted >= 2) {
        setLanding(s, "L5");
        addEvent(s, "VISION LOCK");
      } else if (tin > 20) {
        s.visionDegraded = true;
        setLanding(s, "L5");
        addEvent(s, "VISION DEGRADED · GNSS");
      }
      break;
    case "L5":
      if (s.h <= H_VIS_MIN || s.h <= 40) {
        s.visionEnded = true;
        setLanding(s, "L6");
        addEvent(s, "VISION ENDED");
      }
      break;
    case "L6":
      if (s.h <= 15) {
        setLanding(s, "L7");
        addEvent(s, "FLARE · STEERING STOP");
      }
      break;
    case "L7":
      if (s.h <= 1.5) setLanding(s, "L8");
      break;
    case "L8":
      if (s.h <= 0) {
        s.touchHold += dt;
        if (s.touchHold >= 1) {
          setLanding(s, "L10", "LANDED");
          s.landedT = s.t;
          addEvent(s, "TOUCHDOWN");
          addEvent(s, "MOTORS OFF");
        }
      }
      break;
    case "L9":
      if (s.h <= 0) {
        s.touchHold += dt;
        if (s.touchHold >= 1) {
          setLanding(s, "L10", "LANDED");
          s.landedT = s.t;
          addEvent(s, "TOUCHDOWN");
        }
      }
      break;
    case "L10":
      if (s.landedT !== null && s.t - s.landedT > 6 && s.state === "LANDED") {
        s.state = "MISSION_COMPLETE";
        addEvent(s, "MISSION COMPLETE");
      }
      break;
    default:
      break;
  }
  if ((s.state === "PRIMARY_DESCENT" || s.state === "EJECTION") && s.landing === "L9") s.state = "CONTROLLED_DESCENT";

  // ---- Track, packets, history ---------------------------------------------------
  packetTick(s, dt);
  s.histTimer += dt;
  if (s.histTimer >= 1) {
    s.histTimer -= 1;
    s.path.push({
      e: s.gnssRel[0] + s.tgt[0],
      n: s.gnssRel[1] + s.tgt[1],
      alt: s.h,
      t: s.t - sep,
      ctrl: isControlled(s.landing),
    });
    if (s.path.length > 1500) s.path.shift();
  }
}

function packetTick(s: SimState, dt: number) {
  s.packetTimer += dt;
  if (s.packetTimer >= 1) {
    s.packetTimer -= 1;
    s.packetCount += 1;
    const snr = linkSnr(s);
    const lossP = clamp((4 - snr) * 0.06, 0, 0.6) + 0.004;
    if (s.rnd() < lossP) s.packetsLost += 1;
    else if (s.rnd() < 0.002) s.crcErrors += 1;
  }
}

function slantFromGs(s: SimState): number {
  const dx = s.pos[0] - s.pad[0];
  const dy = s.pos[1] - s.pad[1];
  return Math.hypot(dx, dy, s.h);
}

function linkSnr(s: SimState): number {
  const r = slantFromGs(s);
  return 11 - 6 * Math.log10(1 + r / 60);
}

// ---- Snapshot (what the ground station would decode) ----------------------------
function utcString(): string {
  return new Date().toISOString().slice(11, 19);
}

export function snapshot(s: SimState): CansatFrame {
  const P = PARAMS;
  const sep = s.sepT;
  const met = sep === null ? s.t - T_SEP : s.t - sep;
  const n = () => gauss(s);
  const rel: Vec = [s.pos[0] - s.tgt[0], s.pos[1] - s.tgt[1]];
  const gnssOk = s.t >= s.gnssLostUntil;
  const speedH = norm2(s.vel);
  const course = speedH > 0.05 ? bearingDeg(s.vel[0], s.vel[1]) : 0;

  // thrust and motors
  const armed = isControlled(s.landing) || s.landing === "L9";
  const thrustPct = clamp((s.Tcur / P.T_MAX) * 100, 0, 100);
  const base = armed && s.landing !== "L9" ? Math.max(8, thrustPct) : s.Tcur > 0.05 ? thrustPct : 0;
  const rOut = clamp(s.roll * 0.6, -14, 14);
  const pOut = clamp(s.pitch * 0.6, -14, 14);
  const motors = [base + rOut - pOut, base - rOut - pOut, base - rOut + pOut, base + rOut + pOut].map((m) =>
    base === 0 ? 0 : clamp(m, 0, 100),
  );
  const arms = s.armProg.map((p) => p * 90);
  const armsOpen = s.armProg.filter((p) => p >= 1).length;

  // IMU
  const motorVib = armed ? 0.15 + 0.1 * thrustPct * 0.02 : 0.03;
  const pr = rad(s.pitch);
  const rr = rad(s.roll);
  const shock = s.shock > 0 ? 55 * Math.exp(-(0.3 - s.shock) * 14) : 0;
  const ax = P.G * Math.sin(pr) + n() * motorVib;
  const ay = -P.G * Math.sin(rr) * Math.cos(pr) + n() * motorVib;
  const az = P.G * Math.cos(rr) * Math.cos(pr) + n() * motorVib + shock;
  const gyroNoise = armed ? 1.4 : 0.4;
  const gx = clamp(s.gx, -90, 90) + n() * gyroNoise;
  const gy = clamp(s.gy, -90, 90) + n() * gyroNoise;
  const gz = clamp(s.gz, -90, 90) + n() * gyroNoise;
  // magnetometer (field of the site, body frame)
  const yr = rad(s.yaw);
  const Hn = 33.6;
  const Zd = 31.4;
  const cy = Math.cos(yr);
  const sy = Math.sin(yr);
  const cp = Math.cos(pr);
  const sp = Math.sin(pr);
  const cr = Math.cos(rr);
  const sr = Math.sin(rr);
  const dist = armed ? 6 * (thrustPct / 100 + 0.2) : 0;
  const mx = cp * cy * Hn - sp * Zd + dist * n() * 0.3 + dist * 0.4;
  const my = (sr * sp * cy - cr * sy) * Hn + sr * cp * Zd + dist * n() * 0.3;
  const mz = (cr * sp * cy + sr * sy) * Hn + cr * cp * Zd + dist * n() * 0.3 - dist * 0.3;
  const tiltMag = Math.hypot(s.roll, s.pitch);
  const gyroMag = Math.hypot(gx, gy);
  const stability: CansatFrame["imu"]["stability"] =
    tiltMag > 35 || gyroMag > 80 ? "UNSTABLE" : tiltMag > 8 || gyroMag > 25 ? "SWAYING" : "STABLE";

  // barometer / environment
  const msl = s.h + P.PAD_ELEVATION;
  const pressure = 1013.25 * Math.pow(1 - 2.25577e-5 * msl, 5.25588) + n() * 0.05;
  const baroAlt = s.h + n() * 0.35;
  const temp = 31 - (6.5 * s.h) / 1000 + n() * 0.05;
  const rh = clamp(48 + 10 * (s.h / 1000) + n() * 0.3, 5, 99);

  // power rail (INA219 monitors the electronics bus)
  const servoLoad = s.landing === "L1" ? 0.8 : 0;
  const cameraOn = isControlled(s.landing);
  const curr = 0.38 + (cameraOn ? 0.14 : 0) + servoLoad + 0.002 * thrustPct * 2 + n() * 0.01;
  const busV = 7.82 - 0.0004 * s.t - 0.18 * (curr - 0.38) + n() * 0.004;
  const currentMA = curr * 1000;
  const powerMW = busV * currentMA;

  // GNSS
  const [glat, glon] = enuToLatLon(s.gnssRel[0] + s.tgt[0], s.gnssRel[1] + s.tgt[1]);
  const errG = norm2(s.gnssRel);
  const sats = gnssOk ? 13 + Math.round(n() * 0.8) : 3;
  const gnss = {
    lat: glat,
    lon: glon,
    alt: msl + n() * 1.2,
    speed: speedH + Math.abs(n()) * 0.05,
    sats,
    fix: (gnssOk ? "3D" : "NO FIX") as "3D" | "NO FIX",
    hdop: gnssOk ? 0.9 + Math.abs(n()) * 0.15 : 9.9,
    utc: utcString(),
  };

  // time of flight
  const tofValid = s.h < 4.2 && s.sepT !== null;
  const tof = { mm: tofValid ? Math.round(s.h * 1000 + n() * 12) : null, valid: tofValid };

  // vision
  const band = isControlled(s.landing) && !s.visionEnded ? bandFor(s.h) : 0;
  const pix = PIXEL_FACTOR * s.h;
  const lastFixAge = s.t - s.lastFixT;
  let visionStatus: CansatFrame["visionStatus"] = "OFF";
  if (s.visionEnded) visionStatus = "ENDED";
  else if (s.landing === "L4" || s.landing === "L5") visionStatus = lastFixAge < 3.5 ? "LOCKED" : "SEARCH";

  // errors
  const errV = norm2(s.est);
  const impact: Vec = [s.est[0] + s.west[0] * s.tRem, s.est[1] + s.west[1] * s.tRem];
  const impactMiss = isControlled(s.landing) || s.landing === "L0" || s.landing === "L1" || s.landing === "L2"
    ? norm2([rel[0] + s.vel[0] * s.tRem, rel[1] + s.vel[1] * s.tRem])
    : errG;
  const rangeToTarget = errG;
  const azimuth = bearingDeg(-s.gnssRel[0], -s.gnssRel[1]);
  const ring = ringIndex(s.landing === "L10" ? errG : errV);
  const windSpeed = norm2(s.west);
  const windFrom = (bearingDeg(s.west[0], s.west[1]) + 180) % 360;

  // link
  const slant = slantFromGs(s);
  const snr = linkSnr(s) + n() * 0.6;
  const rssi = -62 - 18 * Math.log10(1 + slant / 60) + n() * 1.2;
  const linkQuality = clamp(50 + 4.5 * snr, 0, 100);

  // interlocks / faults
  const interlocks = [
    { label: "4/4 arms open", ok: armsOpen === 4 },
    { label: "Height window (≤ 600 m)", ok: s.h <= 650 },
    { label: "Attitude within 45°", ok: tiltMag < 45 },
    { label: "Baro / GNSS height agree", ok: Math.abs(gnss.alt - msl) < 60 },
    { label: "Battery above limit", ok: busV > 6.6 },
    { label: "No passive latch", ok: s.landing !== "L9" && !s.forcePassive },
    { label: "Loop timing on time", ok: true },
  ];
  const faults: string[] = [];
  if (!gnssOk) faults.push("GNSS NO FIX");
  if (isControlled(s.landing) && s.visionEnded === false && s.matchC > 0 && s.matchC < P.C_MIN && lastFixAge > 4)
    faults.push("VISION LOW SCORE");
  if (s.visionDegraded) faults.push("VISION DEGRADED");
  if (isControlled(s.landing) && s.reach < norm2(impact) && s.landing !== "L7" && s.landing !== "L8")
    faults.push("TARGET OUT OF REACH");
  if (s.landing === "L9") faults.push("PASSIVE SAFE LATCHED");
  if (busV < 7.0) faults.push("LOW BATTERY");
  if (snr < 2) faults.push("WEAK LINK");

  const health: HealthItem[] = [
    { name: "ICM-20948 IMU", status: stability === "UNSTABLE" ? "WARN" : "OK", detail: `${stability} · tilt ${tiltMag.toFixed(1)}°` },
    { name: "MS5611 Baro", status: "OK", detail: `${pressure.toFixed(1)} hPa` },
    { name: "SHT30", status: "OK", detail: `${temp.toFixed(1)} °C · ${rh.toFixed(0)} %` },
    { name: "INA219", status: busV < 7.0 ? "WARN" : "OK", detail: `${busV.toFixed(2)} V · ${currentMA.toFixed(0)} mA` },
    { name: "L89HA GNSS", status: gnssOk ? "OK" : "WARN", detail: gnssOk ? `3D · ${sats} sats` : "NO FIX" },
    { name: "VL53L1X", status: "OK", detail: tofValid ? `${(tof.mm ?? 0)} mm` : "Idle · range > 4 m" },
    { name: "Camera", status: cameraOn ? "OK" : "OFF", detail: cameraOn ? "Capturing" : "Starts at 600 m" },
    { name: "Flap servos", status: armsOpen === 4 ? "OK" : s.landing === "L1" ? "WARN" : "OFF", detail: `${armsOpen}/4 open` },
    { name: "Motors / ESC", status: s.landing === "L9" ? "WARN" : armed ? "OK" : "OFF", detail: armed ? `${thrustPct.toFixed(0)} % thrust` : "Disarmed" },
    { name: "LoRa radio", status: snr < 2 ? "WARN" : "OK", detail: `${rssi.toFixed(0)} dBm · SNR ${snr.toFixed(1)}` },
    { name: "SD card", status: "OK", detail: "Logging" },
  ];

  const frame: CansatFrame = {
    state: s.state,
    landing: s.landing,
    landingName: landingName(s.landing),
    t: s.t,
    met,
    altitude: s.h,
    descentRate: s.vz,
    vRef: sep === null ? 0 : vRefAt(s.h, s.landing),
    groundSpeed: speedH,
    speed3d: Math.hypot(speedH, s.vz),
    course,
    lat: glat,
    lon: glon,
    posE: s.gnssRel[0],
    posN: s.gnssRel[1],
    rangeToTarget,
    slantToTarget: Math.hypot(rangeToTarget, s.h),
    azimuthToTarget: azimuth,
    errGnss: errG,
    errVision: errV,
    impactE: impact[0],
    impactN: impact[1],
    impactMiss,
    ring,
    ringText: ringLabel(ring),
    windSpeed,
    windFrom,
    tRem: s.tRem,
    vDesGround: s.vDesGround,
    vAirCmd: s.vAirCmd,
    vRelMax: s.vRelMax,
    reach: s.reach,
    reachable: s.reach >= norm2(impact),
    tiltCmd: s.tiltCmd,
    band,
    bandHeight: band > 0 ? BAND_HEIGHTS[band - 1] : 0,
    pixelSize: pix,
    visionStatus,
    matchC: s.matchC,
    matchPsr: s.matchPsr,
    fixesAccepted: s.accepted,
    fixesRejected: s.rejected,
    lastFixAge,
    cameraOn,
    thrustN: s.Tcur,
    thrustPct,
    motors,
    arms,
    armsOpen,
    interlocks,
    faults,
    imu: { ax, ay, az, gx, gy, gz, mx, my, mz, roll: s.roll, pitch: s.pitch, yaw: s.yaw, stability },
    baro: { pressure, altitude: baroAlt, vspeed: -s.vz },
    sht: { temp, rh },
    ina: { busV, currentMA, powerMW },
    gnss,
    tof,
    rssi,
    snr,
    linkQuality,
    packetCount: s.packetCount,
    packetsLost: s.packetsLost,
    crcErrors: s.crcErrors,
    updateRate: 1,
    slantFromGs: slant,
    lastPacketAt: Date.now(),
    health,
    history: s.history,
    path: s.path,
    passivePath: s.passivePath,
    events: s.events,
    padE: s.pad[0],
    padN: s.pad[1],
    targetE: s.tgt[0],
    targetN: s.tgt[1],
    targetLat: enuToLatLon(s.tgt[0], s.tgt[1])[0],
    targetLon: enuToLatLon(s.tgt[0], s.tgt[1])[1],
    propellers: armsOpen === 4 ? "DEPLOYED" : armsOpen > 0 || s.landing === "L1" ? "DEPLOYING" : "STOWED",
    txShutdownIn: met >= 0 ? Math.max(0, 5400 - met) : null,
    autoRestartIn: s.state === "MISSION_COMPLETE" && s.landedT !== null ? Math.max(0, 14 - (s.t - s.landedT - 6)) : null,
  };

  // history rows: one per simulated second after separation
  if (sep !== null && s.state !== "MISSION_COMPLETE") {
    if (met - s.lastRowT >= 0.999) {
      const row: HistRow = {
        t: Math.round(met),
        alt: s.h,
        vref: frame.vRef,
        vz: s.vz,
        gspeed: speedH,
        errG,
        errV,
        miss: impactMiss,
        ax,
        ay,
        az,
        gx,
        gy,
        gz,
        mx,
        my,
        mz,
        roll: s.roll,
        pitch: s.pitch,
        press: pressure,
        temp,
        rh,
        busV,
        curr: currentMA,
        pwr: powerMW,
        tof: tof.mm,
        rssi,
        snr,
        c: s.matchC,
        thrust: thrustPct,
      };
      s.history = [...s.history, row].slice(-1500);
      s.lastRowT = met;
      frame.history = s.history;
    }
  }
  return frame;
}

// ---- Commands -------------------------------------------------------------------
export function simAssistOff(s: SimState): { ok: boolean; reason?: string } {
  if (s.sepT === null) return { ok: false, reason: "Not separated yet" };
  s.forcePassive = true;
  return { ok: true };
}

/** Change the target. It must lie within 1 km of the pad (mission rule). */
export function simSetTarget(s: SimState, lat: number, lon: number): { ok: boolean; reason?: string } {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, reason: "Invalid coordinates" };
  const [e, n] = latLonToEnu(lat, lon);
  const dist = Math.hypot(e - s.pad[0], n - s.pad[1]);
  if (dist > 1000) return { ok: false, reason: `Target ${dist.toFixed(0)} m from pad (limit 1000 m)` };
  if (s.landing !== "IDLE" && s.landing !== "L0" && s.landing !== "L1" && s.landing !== "L2")
    return { ok: false, reason: "Target locked after motor start" };
  const d: Vec = [e - s.tgt[0], n - s.tgt[1]];
  s.tgt = [e, n];
  s.est = [s.est[0] - d[0], s.est[1] - d[1]];
  s.gnssRel = [s.gnssRel[0] - d[0], s.gnssRel[1] - d[1]];
  return { ok: true };
}

/** Run the simulation forward by `seconds`, in sub-steps of at most 0.1 s. */
export function advance(s: SimState, seconds: number) {
  let left = seconds;
  while (left > 1e-9) {
    const dt = Math.min(0.1, left);
    stepSim(s, dt);
    left -= dt;
  }
}

export type { LatLon };
