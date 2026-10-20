import { LiveFrameBuilder } from "./liveFrame";
import {
  LineSplitter,
  RAK_RX,
  encodeCmd,
  isKvTestLine,
  parseKvTest,
  parseLine,
  parseRakLine,
  rakSend,
  splitCommandText,
  type Parsed,
} from "./protocol";

export type LinkFormat = "raw" | "rak";
export type LogTag = "TLM" | "LND" | "EVT" | "ACK" | "EXE" | "BAD" | "AT" | "TX" | "SYS";
export type LogEntry = { id: number; at: number; tag: LogTag; text: string; note?: string };
export type Transport = { write(text: string): Promise<void> };
export type CmdStageCb = (stage: "ACK" | "NAK" | "PASS" | "FAIL", reason?: string) => void;

const ACK_TIMEOUT_MS = 8000;
const EXE_TIMEOUT_MS = 25000;
const LOG_MAX = 400;

type Pending = {
  ui: string;
  args: string[];
  cb: CmdStageCb;
  ackTimer: ReturnType<typeof setTimeout>;
  exeTimer?: ReturnType<typeof setTimeout>;
};

/**
 * The ground-side communication layer (no React): receives raw text from any
 * transport, splits it into lines, unwraps the RAK3272S AT format when needed,
 * decodes packets, feeds the live frame builder, writes the packet log, and
 * runs the command lifecycle (SENT -> ACK/NAK -> PASS/FAIL, with timeouts).
 */
export class GroundLink {
  readonly builder = new LiveFrameBuilder();
  format: LinkFormat = "raw";
  log: LogEntry[] = [];
  /** every raw line with a UTC stamp, for the downloadable log */
  rawLog: string[] = [];

  private transport: Transport | null = null;
  private splitter = new LineSplitter();
  private pending = new Map<number, Pending>();
  private logId = 0;
  private kvFirstAt = 0;
  private kvCount = 0;
  private cmdId = 1;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  setTransport(t: Transport | null) {
    this.transport = t;
    this.splitter.reset();
  }
  get connected() {
    return this.transport !== null;
  }

  /** Clear the decoded data and the monitor (keeps nothing of the previous flight). */
  reset() {
    this.builder.reset();
    this.kvFirstAt = 0;
    this.kvCount = 0;
    this.log = [];
    this.rawLog = [];
    this.cancelPending("RESET");
    this.emit();
  }

  private addLog(tag: LogTag, text: string, note?: string) {
    this.log.push({ id: ++this.logId, at: Date.now(), tag, text, note });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }

  info(text: string) {
    this.addLog("SYS", text);
    this.emit();
  }

  // ---- receive --------------------------------------------------------------------
  /** Raw text from a serial port (any chunking). */
  feedText(text: string) {
    for (const line of this.splitter.push(text)) this.feedLine(line);
  }

  feedLine(line: string, now = Date.now()) {
    const t = line.trim();
    if (!t) return;
    this.rawLog.push(`${new Date(now).toISOString()} ${t}`);
    if (this.rawLog.length > 50000) this.rawLog.shift();

    if (this.format === "rak" || /^\+EVT:|^AT_|^OK$/.test(t)) {
      const ev = parseRakLine(t);
      if (ev.kind === "rx") {
        this.process(ev.payload, { rssi: ev.rssi, snr: ev.snr, at: now });
      } else if (ev.kind === "txdone") {
        this.addLog("AT", t);
        this.write(RAK_RX, false); // back to continuous receive after a transmit
      } else if (ev.kind === "ok" || ev.kind === "error" || ev.kind === "text") {
        const looksLikePacket = ev.kind === "text" && (t.startsWith("$") || t.includes(","));
        if (looksLikePacket) this.process(t, { at: now });
        else this.addLog("AT", t, ev.kind === "error" ? "radio error" : undefined);
      }
    } else {
      this.process(t, { at: now });
    }
    this.emit();
  }

  private process(payload: string, rx: { rssi?: number; snr?: number; at: number }) {
    let p: Parsed | null;
    if (isKvTestLine(payload.trim())) {
      // bench-test transmitter (ALT=..,TEMP=..,VBAT=..): the ground side supplies time and packet count
      if (this.kvFirstAt === 0) this.kvFirstAt = rx.at;
      p = parseKvTest(payload.trim(), (rx.at - this.kvFirstAt) / 1000, ++this.kvCount);
    } else p = parseLine(payload);
    if (!p) return;
    switch (p.kind) {
      case "tlm":
        this.addLog("TLM", p.raw, p.warnings.length ? p.warnings.join("; ") : undefined);
        this.builder.ingest(p, rx);
        break;
      case "lnd":
        this.addLog("LND", p.raw, p.warnings.length ? p.warnings.join("; ") : undefined);
        this.builder.ingest(p, rx);
        break;
      case "evt":
        this.addLog("EVT", p.raw);
        this.builder.ingest(p, rx);
        break;
      case "ack":
        this.addLog("ACK", p.raw, p.ok ? undefined : p.reason);
        this.onAck(p.id, p.ok, p.reason);
        break;
      case "exe":
        this.addLog("EXE", p.raw, p.ok ? undefined : p.reason);
        this.onExe(p.id, p.ok, p.reason);
        break;
      case "header":
        this.addLog("SYS", p.raw, "header row ignored");
        break;
      case "error":
        this.addLog("BAD", p.raw, p.error);
        this.builder.ingest(p, rx);
        break;
    }
  }

  // ---- transmit ---------------------------------------------------------------------
  private async write(line: string, log = true) {
    if (!this.transport) return;
    try {
      await this.transport.write(line + "\r\n");
      if (log) this.addLog("TX", line);
    } catch (e) {
      this.addLog("SYS", `write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.emit();
  }

  /** Send a command and report ACK/NAK then PASS/FAIL through `cb`. */
  sendCommand(commandText: string, cb: CmdStageCb) {
    const { name, args } = splitCommandText(commandText);
    if (!this.transport) {
      cb("NAK", "NOT CONNECTED");
      return;
    }
    const id = this.cmdId++;
    const packet = encodeCmd(id, name, args);
    const ackTimer = setTimeout(() => {
      this.pending.delete(id);
      cb("NAK", "NO ACK (timeout)");
      this.addLog("SYS", `command ${id} ${name}: no ACK within ${ACK_TIMEOUT_MS / 1000} s`);
      this.emit();
    }, ACK_TIMEOUT_MS);
    this.pending.set(id, { ui: name, args, cb, ackTimer });
    void this.write(this.format === "rak" ? rakSend(packet) : packet, false).then(() => {
      this.addLog("TX", packet, this.format === "rak" ? "wrapped in AT+PSEND" : undefined);
      this.emit();
    });
  }

  private onAck(id: number, ok: boolean, reason?: string) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.ackTimer);
    if (!ok) {
      this.pending.delete(id);
      p.cb("NAK", reason);
      return;
    }
    p.cb("ACK");
    p.exeTimer = setTimeout(() => {
      this.pending.delete(id);
      p.cb("FAIL", "NO EXEC REPORT (timeout)");
      this.addLog("SYS", `command ${id} ${p.ui}: no execution report within ${EXE_TIMEOUT_MS / 1000} s`);
      this.emit();
    }, EXE_TIMEOUT_MS);
  }

  private onExe(id: number, ok: boolean, reason?: string) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.ackTimer);
    if (p.exeTimer) clearTimeout(p.exeTimer);
    this.pending.delete(id);
    if (ok && p.ui === "SET_TARGET" && p.args.length >= 2) {
      const lat = Number(p.args[0]);
      const lon = Number(p.args[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) this.builder.setTarget(lat, lon);
    }
    p.cb(ok ? "PASS" : "FAIL", reason);
  }

  private cancelPending(reason: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.ackTimer);
      if (p.exeTimer) clearTimeout(p.exeTimer);
      p.cb("NAK", reason);
    }
    this.pending.clear();
  }

  dispose() {
    this.cancelPending("LINK CLOSED");
    this.transport = null;
    this.listeners.clear();
  }
}
