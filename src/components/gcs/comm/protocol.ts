/**
 * GATSAT CanSat ground link protocol (DRAFT v0.1, system side).
 *
 * ONE place that says what travels over the radio. The embedded team edits the
 * tables below (or tells us what to change) and the parser, the monitor and the
 * command flow all follow. Pure TypeScript, no React, so it is testable in Node.
 *
 * Line types, all ASCII, one packet per line, ending CR/LF:
 *
 *   TLM   plain CSV, the 16 Annexure-2 fields (19 columns, see TLM_FIELDS).
 *         An optional "*HH" XOR checksum may be appended. Written to the CSV
 *         log exactly as the rulebook wants it.
 *   $LND  landing-logic extension (state, thrust, image match, estimate ...)
 *   $EVT  mission event label
 *   $CMD  uplink command           ground  -> CanSat
 *   $ACK  command received         CanSat  -> ground   (ACK | NAK)
 *   $EXE  command executed         CanSat  -> ground   (PASS | FAIL)
 *
 * "$" lines always end with "*HH", where HH is the XOR of every character
 * between "$" and "*", as two upper-case hex digits (NMEA style).
 *
 * ITEMS MARKED "CONFIRM" ARE ASSUMPTIONS the electronics team must confirm.
 */

// ---- field tables ---------------------------------------------------------
export type FieldType = "str" | "int" | "float";
export type FieldDef = {
  key: string;
  label: string;
  unit: string;
  type: FieldType;
  /** valid range; out-of-range values are flagged and dropped, the packet is kept */
  min?: number;
  max?: number;
  sensor?: string;
};

/** CONFIRM: order and the 3-value accelerometer follow the PDR sample packet. */
export const TLM_FIELDS: FieldDef[] = [
  { key: "teamId", label: "TEAM ID", unit: "", type: "str" },
  { key: "time", label: "TIME STAMPING", unit: "s", type: "float", min: 0, max: 86400 * 2, sensor: "RTC" },
  { key: "count", label: "PACKET COUNT", unit: "", type: "int", min: 0, max: 1e7, sensor: "software" },
  { key: "alt", label: "ALTITUDE", unit: "m", type: "float", min: -100, max: 5000, sensor: "barometer" },
  { key: "press", label: "PRESSURE", unit: "Pa", type: "float", min: 30000, max: 110000, sensor: "barometer" },
  { key: "temp", label: "TEMP", unit: "°C", type: "float", min: -60, max: 125, sensor: "temperature" },
  { key: "volt", label: "VOLTAGE", unit: "V", type: "float", min: 0, max: 30, sensor: "INA219" },
  { key: "gnssTime", label: "GNSS TIME", unit: "s", type: "float", min: 0, max: 86400 * 2, sensor: "GNSS" },
  { key: "lat", label: "GNSS LATITUDE", unit: "°", type: "float", min: -90, max: 90, sensor: "GNSS" },
  { key: "lon", label: "GNSS LONGITUDE", unit: "°", type: "float", min: -180, max: 180, sensor: "GNSS" },
  { key: "gnssAlt", label: "GNSS ALTITUDE", unit: "m", type: "float", min: -500, max: 20000, sensor: "GNSS" },
  { key: "sats", label: "GNSS SATS", unit: "", type: "int", min: 0, max: 60, sensor: "GNSS" },
  { key: "ax", label: "ACCEL X", unit: "m/s²", type: "float", min: -200, max: 200, sensor: "IMU" },
  { key: "ay", label: "ACCEL Y", unit: "m/s²", type: "float", min: -200, max: 200, sensor: "IMU" },
  { key: "az", label: "ACCEL Z", unit: "m/s²", type: "float", min: -200, max: 200, sensor: "IMU" },
  { key: "spin", label: "GYRO SPIN RATE", unit: "°/s", type: "float", min: -2000, max: 2000, sensor: "IMU" },
  { key: "state", label: "FLIGHT SOFTWARE STATE", unit: "", type: "str" },
  { key: "hum", label: "OPTIONAL · HUMIDITY", unit: "%", type: "float", min: 0, max: 100, sensor: "temperature" },
  { key: "curr", label: "OPTIONAL · CURRENT", unit: "mA", type: "float", min: -5000, max: 20000, sensor: "INA219" },
];

/** Rulebook 6.3 display / CSV resolution (decimal places) for the mandatory fields. */
export const RULEBOOK_DECIMALS: Record<string, number> = {
  alt: 1,
  press: 0,
  temp: 1,
  volt: 2,
  lat: 4,
  lon: 4,
  gnssAlt: 1,
};

/** Rulebook 6.3 flight-software state examples (numeric form -> name). */
export const RULEBOOK_STATES = ["BOOT", "TEST_MODE", "LAUNCH_PAD", "ASCENT", "ROCKET_DEPLOY", "DESCENT", "AEROBREAK_RELEASE", "IMPACT"];

/** Column header for the judges' CSV: full field name with its unit. */
export const csvHeader = (d: FieldDef) => (d.unit ? `${d.label} (${d.unit})` : d.label);

/** Format one value for the judges' CSV at the rulebook resolution. */
export function csvCell(d: FieldDef, v: number | string | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "";
  const dec = RULEBOOK_DECIMALS[d.key];
  return dec !== undefined ? v.toFixed(dec) : String(v);
}

/** CONFIRM: landing-logic extension, about 1 per second. */
export const LND_FIELDS: FieldDef[] = [
  { key: "met", label: "MET (since separation)", unit: "s", type: "float", min: -1000, max: 5000 },
  { key: "landing", label: "LANDING STATE", unit: "L0..L10", type: "str" },
  { key: "thrustPct", label: "THRUST", unit: "%", type: "float", min: 0, max: 100 },
  { key: "matchC", label: "IMAGE MATCH SCORE", unit: "", type: "float", min: -1, max: 1 },
  { key: "matchPsr", label: "IMAGE MATCH PSR", unit: "", type: "float", min: 0, max: 100 },
  { key: "estE", label: "EST. POSITION EAST", unit: "m", type: "float", min: -5000, max: 5000 },
  { key: "estN", label: "EST. POSITION NORTH", unit: "m", type: "float", min: -5000, max: 5000 },
  { key: "tilt", label: "TILT COMMAND", unit: "°", type: "float", min: -45, max: 45 },
  { key: "band", label: "ALTITUDE BAND", unit: "", type: "int", min: 0, max: 40 },
  { key: "vision", label: "VISION STATUS", unit: "", type: "str" },
  { key: "roll", label: "ROLL", unit: "°", type: "float", min: -180, max: 180 },
  { key: "pitch", label: "PITCH", unit: "°", type: "float", min: -180, max: 180 },
  { key: "yaw", label: "YAW", unit: "°", type: "float", min: -360, max: 360 },
  { key: "tofMm", label: "TOF DISTANCE", unit: "mm", type: "float", min: -1, max: 10000 },
  { key: "arms", label: "ARMS OPEN", unit: "of 4", type: "int", min: 0, max: 4 },
  { key: "windS", label: "WIND EST. SPEED", unit: "m/s", type: "float", min: 0, max: 60 },
  { key: "windFrom", label: "WIND EST. FROM", unit: "°", type: "float", min: 0, max: 360 },
];

export type Values = Record<string, number | string>;

// ---- checksum and framing ---------------------------------------------------
export function xorChecksum(text: string): string {
  let x = 0;
  for (let i = 0; i < text.length; i++) x ^= text.charCodeAt(i) & 0xff;
  return x.toString(16).toUpperCase().padStart(2, "0");
}

/** "$BODY*HH" for a body without the leading "$". */
export function frameExt(body: string): string {
  return `$${body}*${xorChecksum(body)}`;
}

export type Unframed =
  | { ok: true; body: string; hadChecksum: boolean }
  | { ok: false; error: string };

/**
 * Strip and check an optional "*HH" suffix. `required` is true for "$" lines.
 * Lines whose checksum is wrong are rejected here.
 */
export function unframe(line: string, required: boolean): Unframed {
  const star = line.lastIndexOf("*");
  if (star < 0) return required ? { ok: false, error: "missing checksum" } : { ok: true, body: line, hadChecksum: false };
  const body = line.slice(0, star);
  const given = line.slice(star + 1).trim().toUpperCase();
  if (!/^[0-9A-F]{2}$/.test(given)) {
    return required ? { ok: false, error: "bad checksum field" } : { ok: true, body: line, hadChecksum: false };
  }
  const want = xorChecksum(body.startsWith("$") ? body.slice(1) : body);
  if (want !== given) return { ok: false, error: `checksum mismatch (got ${given}, expected ${want})` };
  return { ok: true, body: body.startsWith("$") ? body.slice(1) : body, hadChecksum: true };
}

// ---- parsing ------------------------------------------------------------------
function parseFields(defs: FieldDef[], cols: string[]): { values: Values; warnings: string[] } | { error: string } {
  if (cols.length !== defs.length) return { error: `expected ${defs.length} fields, got ${cols.length}` };
  const values: Values = {};
  const warnings: string[] = [];
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const raw = cols[i].trim();
    if (d.type === "str") {
      values[d.key] = raw;
      continue;
    }
    if (raw === "") {
      values[d.key] = NaN; // spec v1.0: an empty field means "no valid reading"
      continue;
    }
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) {
      values[d.key] = NaN;
      warnings.push(`${d.label}: "${raw}" is not a number`);
      continue;
    }
    let v = Number(raw);
    if (d.type === "int") v = Math.round(v);
    if ((d.min !== undefined && v < d.min) || (d.max !== undefined && v > d.max)) {
      warnings.push(`${d.label}: ${v} outside ${d.min}..${d.max}`);
      v = NaN;
    }
    values[d.key] = v;
  }
  return { values, warnings };
}

export type Parsed =
  | { kind: "tlm"; values: Values; warnings: string[]; raw: string }
  | { kind: "lnd"; values: Values; warnings: string[]; raw: string }
  | { kind: "evt"; met: number; label: string; raw: string }
  | { kind: "ack"; id: number; ok: boolean; reason?: string; raw: string }
  | { kind: "exe"; id: number; ok: boolean; reason?: string; raw: string }
  | { kind: "header"; raw: string }
  | { kind: "error"; error: string; raw: string };

/** Bench-test lines like `ALT=100.0,TEMP=28.0,VBAT=18.50` (key=value, no packet count or time). */
const KV_KEYS: Record<string, string> = {
  ALT: "alt", ALTITUDE: "alt", PRESS: "press", PRESSURE: "press", TEMP: "temp", VBAT: "volt", VOLT: "volt", VOLTAGE: "volt",
  LAT: "lat", LON: "lon", LONG: "lon", GALT: "gnssAlt", SATS: "sats", HUM: "hum", CURR: "curr", SPIN: "spin",
  AX: "ax", AY: "ay", AZ: "az",
};

export function isKvTestLine(raw: string): boolean {
  const parts = raw.split(",");
  return parts.length > 0 && parts.every((p) => /^\s*[A-Za-z_]+\s*=\s*-?[\d.]+\s*$/.test(p));
}

/** Values for a bench-test line; unknown keys are ignored, everything else stays NaN ("—" on screen). */
export function parseKvTest(raw: string, time: number, count: number): Parsed {
  const values: Values = {};
  for (const d of TLM_FIELDS) values[d.key] = d.type === "str" ? "" : NaN;
  const seen: string[] = [];
  const warnings: string[] = ["bench test line (not flight telemetry)"];
  for (const p of raw.split(",")) {
    const [k, v] = p.split("=").map((s) => s.trim());
    const key = KV_KEYS[k.toUpperCase()];
    const def = TLM_FIELDS.find((d) => d.key === key);
    if (!def) {
      warnings.push(`unknown key ${k}`);
      continue;
    }
    const n = Number(v);
    const ok = Number.isFinite(n) && (def.min === undefined || n >= def.min) && (def.max === undefined || n <= def.max);
    values[def.key] = ok ? n : NaN;
    if (!ok) warnings.push(`${k} out of range`);
    seen.push(k);
  }
  values.teamId = "BENCH-TEST";
  values.time = time;
  values.count = count;
  values.state = "TEST_MODE";
  return { kind: "tlm", values, warnings, raw };
}

export function parseLine(rawLine: string): Parsed | null {
  const raw = rawLine.replace(/[\r\n]+/g, "").trim();
  if (raw === "") return null;

  if (raw.startsWith("$")) {
    const u = unframe(raw, true);
    if (!u.ok) return { kind: "error", error: u.error, raw };
    const parts = u.body.split(",");
    const type = parts[0].toUpperCase();
    const rest = parts.slice(1);
    if (type === "LND") {
      const r = parseFields(LND_FIELDS, rest);
      return "error" in r ? { kind: "error", error: `LND ${r.error}`, raw } : { kind: "lnd", ...r, raw };
    }
    if (type === "EVT") {
      if (rest.length < 2) return { kind: "error", error: "EVT needs 2 fields", raw };
      return { kind: "evt", met: Number(rest[0]), label: rest.slice(1).join(",").trim().toUpperCase(), raw };
    }
    if (type === "ACK" || type === "EXE") {
      if (rest.length < 2) return { kind: "error", error: `${type} needs id and result`, raw };
      const id = Number(rest[0]);
      const res = rest[1].trim().toUpperCase();
      const ok = type === "ACK" ? res === "ACK" : res === "PASS";
      const valid = type === "ACK" ? res === "ACK" || res === "NAK" : res === "PASS" || res === "FAIL";
      if (!Number.isInteger(id) || !valid) return { kind: "error", error: `bad ${type} packet`, raw };
      const reason = rest.slice(2).join(",").trim() || undefined;
      return type === "ACK" ? { kind: "ack", id, ok, reason, raw } : { kind: "exe", id, ok, reason, raw };
    }
    return { kind: "error", error: `unknown packet type ${type}`, raw };
  }

  // plain telemetry line
  const u = unframe(raw, false);
  if (!u.ok) return { kind: "error", error: u.error, raw };
  const cols = u.body.split(",");
  if (cols[0].trim().toUpperCase() === "TEAM_ID" || cols[0].trim().toUpperCase() === "TEAM ID") return { kind: "header", raw };
  const wide = expandWire(cols);
  if ("error" in wide) return { kind: "error", error: `TLM ${wide.error}`, raw };
  const r = parseFields(TLM_FIELDS, wide.cols);
  if ("error" in r) return { kind: "error", error: `TLM ${r.error}`, raw };
  r.values.roll = wide.roll;
  r.values.pitch = wide.pitch;
  return { kind: "tlm", ...r, raw };
}

/** Spec v1.0 wire line: 17 columns, the accelerometer is ONE field "ax;ay;az[;roll;pitch]". */
export const WIRE_COLS = 17;
const ACCEL_AT = 12;

function angle(s: string | undefined): number {
  const t = (s ?? "").trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  const v = Number(t);
  return v >= -180 && v <= 180 ? v : NaN;
}

/** Turn a 17-column wire line into the internal 19 columns (ax, ay, az separate). Legacy 19-column lines pass through. */
function expandWire(cols: string[]): { cols: string[]; roll: number; pitch: number } | { error: string } {
  if (cols.length === TLM_FIELDS.length) return { cols, roll: NaN, pitch: NaN };
  if (cols.length !== WIRE_COLS) return { error: `expected ${WIRE_COLS} fields (or ${TLM_FIELDS.length}), got ${cols.length}` };
  const parts = cols[ACCEL_AT].split(";");
  if (parts.length !== 1 && parts.length !== 3 && parts.length !== 5)
    return { error: "accelerometer field needs ax;ay;az or ax;ay;az;roll;pitch" };
  if (parts.length === 1 && parts[0].trim() !== "") return { error: "accelerometer field needs ax;ay;az or ax;ay;az;roll;pitch" };
  const [ax = "", ay = "", az = ""] = parts.length === 1 ? [] : parts;
  return {
    cols: [...cols.slice(0, ACCEL_AT), ax, ay, az, ...cols.slice(ACCEL_AT + 1)],
    roll: angle(parts[3]),
    pitch: angle(parts[4]),
  };
}

// ---- building packets (virtual CanSat, tests) -------------------------------
/** Decimals on the wire (spec v1.0): GNSS latitude/longitude carry 6 for the landing logic. */
const TX_DECIMALS: Record<string, number> = {
  time: 1, alt: 1, press: 0, temp: 1, volt: 2, gnssTime: 0, lat: 6, lon: 6, gnssAlt: 1, spin: 1, hum: 1, curr: 0,
};

const fmt = (d: FieldDef, v: number | string): string => {
  if (d.type === "str") return String(v);
  const n = Number(v);
  if (d.type === "int") return String(Math.round(n));
  if (!Number.isFinite(n)) return "";
  const dec = TX_DECIMALS[d.key];
  return dec !== undefined ? n.toFixed(dec) : String(Math.round(n * 1e4) / 1e4);
};

/** Accelerometer cell of the wire line: ax;ay;az;roll;pitch, empty when nothing is known. */
export function accelCell(v: Values, dec = 2): string {
  const one = (k: string) => {
    const n = Number(v[k]);
    return Number.isFinite(n) ? String(Math.round(n * 10 ** dec) / 10 ** dec) : "";
  };
  const cells = ["ax", "ay", "az", "roll", "pitch"].map(one);
  if (cells.every((c) => c === "")) return "";
  return (cells[3] === "" && cells[4] === "" ? cells.slice(0, 3) : cells).join(";");
}

/** Spec v1.0 telemetry line (17 columns). No checksum by default, as the spec says. */
export function encodeTlm(values: Values, withChecksum = false): string {
  const cell = (d: FieldDef) => fmt(d, values[d.key] ?? (d.type === "str" ? "" : NaN));
  const body = [...TLM_FIELDS.slice(0, ACCEL_AT).map(cell), accelCell(values), ...TLM_FIELDS.slice(ACCEL_AT + 3).map(cell)].join(",");
  return withChecksum ? `${body}*${xorChecksum(body)}` : body;
}

export function encodeLnd(values: Values): string {
  return frameExt(["LND", ...LND_FIELDS.map((d) => fmt(d, values[d.key] ?? (d.type === "str" ? "" : NaN)))].join(","));
}

export const encodeEvt = (met: number, label: string) => frameExt(`EVT,${met.toFixed(1)},${label}`);
export const encodeAck = (id: number, ok: boolean, reason?: string) =>
  frameExt(`ACK,${id},${ok ? "ACK" : "NAK"}${reason ? `,${reason}` : ""}`);
export const encodeExe = (id: number, ok: boolean, reason?: string) =>
  frameExt(`EXE,${id},${ok ? "PASS" : "FAIL"}${reason ? `,${reason}` : ""}`);

// ---- commands -------------------------------------------------------------------
/** UI command name -> wire name. CONFIRM everything except CXON (rulebook). */
export const COMMAND_WIRE: Record<string, string> = {
  START_TRANSMISSION: "CXON",
  STOP_TELEMETRY: "CXOFF",
  IMU_CALIBRATION: "CAL_IMU",
  ZERO_ALTITUDE: "ZERO_ALT",
  ZERO_ACCEL: "ZERO_ACC",
  COMM_TEST: "PING",
  SERVO_TRIGGER: "SERVO",
  DEPLOY_CHUTE: "CHUTE",
  SIMULATION_ENABLE: "SIM_EN",
  SIMULATION_ACTIVATE: "SIM_ACT",
  ASSIST_OFF: "ASSIST_OFF",
  SET_TARGET: "SET_TGT",
};

export function encodeCmd(id: number, uiName: string, args: (string | number)[] = []): string {
  const wire = COMMAND_WIRE[uiName] ?? uiName;
  return frameExt(["CMD", id, wire, ...args].join(","));
}

export const WIRE_TO_UI: Record<string, string> = Object.fromEntries(Object.entries(COMMAND_WIRE).map(([ui, w]) => [w, ui]));

/** Decode an uplink "$CMD,id,NAME,args*HH" line (used by the virtual CanSat and tests). */
export function parseCmdLine(raw: string):
  | { ok: true; id: number; wire: string; ui: string; args: string[] }
  | { ok: false; error: string } {
  const line = raw.replace(/[\r\n]+/g, "").trim();
  if (!line.startsWith("$")) return { ok: false, error: "not a $ packet" };
  const u = unframe(line, true);
  if (!u.ok) return { ok: false, error: u.error };
  const [type, idText, wire, ...args] = u.body.split(",");
  const id = Number(idText);
  if (type.toUpperCase() !== "CMD" || !Number.isInteger(id) || !wire) return { ok: false, error: "bad CMD packet" };
  return { ok: true, id, wire, ui: WIRE_TO_UI[wire] ?? wire, args };
}

/** "SET_TARGET 26.71754,84.30154" style console text -> name + args. */
export function splitCommandText(text: string): { name: string; args: string[] } {
  const [name, ...rest] = text.trim().split(/\s+/);
  const args = rest.join(" ").split(",").map((s) => s.trim()).filter(Boolean);
  return { name, args };
}

// ---- RAK3272S (RUI3 P2P) wrapping -- CONFIRM against your firmware version -------
export const asciiToHex = (s: string): string =>
  Array.from(s, (c) => (c.charCodeAt(0) & 0xff).toString(16).padStart(2, "0")).join("").toUpperCase();

export function hexToAscii(hex: string): string | null {
  const h = hex.trim();
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) return null;
  let out = "";
  for (let i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return out;
}

/** AT command that transmits `payload` over P2P. */
export const rakSend = (payload: string) => `AT+PSEND=${asciiToHex(payload)}`;
/** Put the radio back into continuous receive. */
export const RAK_RX = "AT+PRECV=65534";

export type RakEvent =
  | { kind: "rx"; rssi: number; snr: number; payload: string }
  | { kind: "txdone" }
  | { kind: "ok" }
  | { kind: "error"; text: string }
  | { kind: "text"; text: string };

/**
 * Interpret a line coming from a RAK3272S in AT mode, e.g.
 *   +EVT:RXP2P:-68:11:323032362C31...      a received packet (RSSI, SNR, hex payload)
 *   +EVT:TXP2P DONE                         transmit finished
 */
export function parseRakLine(line: string): RakEvent {
  const t = line.trim();
  const m = /^\+EVT:RXP2P:(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?):([0-9a-fA-F]*)$/.exec(t);
  if (m) {
    const payload = hexToAscii(m[3]);
    if (payload !== null) return { kind: "rx", rssi: Number(m[1]), snr: Number(m[2]), payload };
    return { kind: "error", text: "RX payload is not valid hex" };
  }
  if (/^\+EVT:TXP2P/i.test(t)) return { kind: "txdone" };
  if (t === "OK") return { kind: "ok" };
  if (/^AT_/.test(t) || /ERROR/i.test(t)) return { kind: "error", text: t };
  return { kind: "text", text: t };
}

// ---- stream splitting -----------------------------------------------------------
/** Turns arbitrary serial chunks into whole lines (CR, LF or CRLF). */
export class LineSplitter {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.search(/[\r\n]/)) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.length) out.push(line);
    }
    if (this.buf.length > 2048) this.buf = ""; // runaway garbage without a line end
    return out;
  }
  reset() {
    this.buf = "";
  }
}
