import type { LogEntry } from "./groundLink";
import type { LiveFrameBuilder } from "./liveFrame";
import { TEAM_COLUMNS } from "./protocol";
import { buildXlsx, type Cell, type Sheet } from "./xlsx";

const UNITS: Record<string, string> = {
  teamId: "", count: "", time: "s", state: "", alt: "m", press: "hPa", temp: "°C", hum: "%", tof: "mm",
  ax: "mg", ay: "mg", az: "mg", gx: "dps", gy: "dps", gz: "dps", mx: "uT", my: "uT", mz: "uT",
  lat: "deg", lon: "deg", gnssAlt: "m", sats: "", volt: "V", curr: "mA", pwr: "mW", gsp: "km/h", servo: "deg", esc: "us",
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r = (x: number | null, d = 4): number | null => (x === null ? null : Number(x.toFixed(d)));

/** Everything received in this session as an Excel workbook (.xlsx). */
export function buildSessionXlsx(builder: LiveFrameBuilder, log: LogEntry[]): Uint8Array {
  const rows = builder.rows();

  // 1) all 28 CanSat fields in the team's own units, plus the link readings
  const head: Cell[] = [
    "Received (UTC)",
    ...TEAM_COLUMNS.map((c) => (UNITS[c.key] ? `${c.name.replace(/_(mg|dps|uT|hpa|m|s|C|V|mA|mW|kmph|deg|us|mm|pct)$/i, "")} (${UNITS[c.key]})` : c.name)),
    "RSSI (dBm)",
    "SNR (dB)",
  ];
  const telemetry: Cell[][] = [head];
  for (const v of rows) {
    const line: Cell[] = [typeof v.rxAt === "number" ? new Date(v.rxAt).toISOString() : ""];
    for (const c of TEAM_COLUMNS) {
      const x = v[c.key];
      if (c.text) line.push(typeof x === "string" ? x : "");
      else {
        const n = num(x);
        line.push(r(n === null ? null : n / (c.scale ?? 1)));
      }
    }
    line.push(num(v.rssi), num(v.snr));
    telemetry.push(line);
  }

  // 2) rulebook layout (the same text as the Flight CSV button)
  const csv: Cell[][] = builder
    .csv()
    .trim()
    .split(/\r?\n/)
    .map((l, i) => l.split(",").map((c) => (i > 0 && c !== "" && Number.isFinite(Number(c)) ? Number(c) : c)));

  // 3) events and 4) packet log
  const events: Cell[][] = [["Time since start (s)", "Event"], ...builder.eventList().map((e) => [e.t, e.label] as Cell[])];
  const pkt: Cell[][] = [["Time (UTC)", "Type", "Text", "Note"], ...log.map((e) => [new Date(e.at).toISOString(), e.tag, e.text, e.note ?? ""] as Cell[])];

  const sheets: Sheet[] = [
    { name: "Telemetry", rows: telemetry },
    { name: "Flight CSV", rows: csv },
    { name: "Events", rows: events },
    { name: "Packet log", rows: pkt },
  ];
  return buildXlsx(sheets);
}
