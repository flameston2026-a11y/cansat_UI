import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTelemetry, type PlaybackSpeed } from "../telemetry";
import { GroundLink, type CmdStageCb, type LinkFormat } from "./groundLink";
import { buildSessionXlsx } from "./exportXlsx";
import { LiveFrameBuilder } from "./liveFrame";
import { RAK_RX, asciiToHex, hexToAscii } from "./protocol";
import { openSerial, serialSupported, type OpenSerial } from "./serialPort";
import { VirtualCansat } from "./virtualCansat";

export type SourceMode = "sim" | "none" | "loopback" | "serial" | "replay";
export type LinkStatus = "idle" | "connecting" | "connected" | "error";
const SPEED: Record<PlaybackSpeed, number> = { "1x": 1, "5x": 5, "10x": 10 };
const TICK = 0.2;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBytes(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * One hook for every telemetry source. The screens only ever see `cansat`
 * (a CansatFrame); where it comes from is decided here:
 *   sim      built-in simulator (default, no hardware)
 *   loopback virtual CanSat speaking the real protocol through the real decoder
 *   serial   a real ground receiver on a USB serial port (Web Serial)
 *   replay   a recorded log file played back
 */
export function useGroundLink(speed: PlaybackSpeed, paused: boolean) {
  const [mode, setModeState] = useState<SourceMode>("sim");
  const [status, setStatus] = useState<LinkStatus>("connected");
  const [error, setError] = useState<string | null>(null);
  const [baud, setBaud] = useState(115200);
  const [format, setFormatState] = useState<LinkFormat>("raw");
  const [label, setLabel] = useState("built-in simulator");
  /** false: the link keeps logging but the website sections show the empty state ("Disconnect from website") */
  const [published, setPublished] = useState(true);
  const emptyFrame = useMemo(() => new LiveFrameBuilder().frame(Date.now()), []);

  const sim = useTelemetry(speed, paused || mode !== "sim");

  const linkRef = useRef<GroundLink | null>(null);
  if (linkRef.current === null) linkRef.current = new GroundLink();
  const link = linkRef.current;

  const [liveFrame, setLiveFrame] = useState(() => link.builder.frame(Date.now()));
  const [, setTick] = useState(0);

  const speedRef = useRef(speed);
  const pausedRef = useRef(paused);
  const formatRef = useRef(format);
  speedRef.current = speed;
  pausedRef.current = paused;
  formatRef.current = format;
  link.format = format;

  const serialRef = useRef<OpenSerial | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const virtualRef = useRef<VirtualCansat | null>(null);
  const replayRef = useRef<{ lines: string[]; idx: number; budget: number } | null>(null);

  // refresh the frame when packets arrive (throttled) and every 500 ms for link ageing
  useEffect(() => {
    let dirty = false;
    const unsub = link.subscribe(() => {
      if (dirty) return;
      dirty = true;
      setTimeout(() => {
        dirty = false;
        setLiveFrame(link.builder.frame(Date.now()));
        setTick((t) => t + 1);
      }, 120);
    });
    const id = setInterval(() => {
      if (mode !== "sim") setLiveFrame(link.builder.frame(Date.now()));
    }, 500);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, [link, mode]);

  const stopAll = useCallback(async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    virtualRef.current = null;
    replayRef.current = null;
    link.setTransport(null);
    const s = serialRef.current;
    serialRef.current = null;
    if (s) await s.close();
  }, [link]);

  useEffect(
    () => () => {
      void stopAll();
    },
    [stopAll],
  );

  const setMode = useCallback(
    async (m: SourceMode) => {
      await stopAll();
      setError(null);
      setPublished(true);
      setModeState(m);
      if (m === "sim") {
        setStatus("connected");
        setLabel("built-in simulator");
      } else {
        link.reset();
        setLiveFrame(link.builder.frame(Date.now()));
        setStatus("idle");
        setLabel("");
      }
    },
    [link, stopAll],
  );

  /** Stop the simulation everywhere on the site and clear every section back to its empty state. */
  const stopSimulation = useCallback(async () => {
    await stopAll();
    link.reset();
    setError(null);
    setPublished(true);
    setModeState("none");
    setLiveFrame(link.builder.frame(Date.now()));
    setStatus("idle");
    setLabel("simulation stopped · no data");
  }, [link, stopAll]);

  const startSimulation = useCallback(async () => {
    await stopAll();
    link.reset();
    setError(null);
    setPublished(true);
    setModeState("sim");
    setStatus("connected");
    setLabel("built-in simulator");
    sim.restart();
  }, [link, sim, stopAll]);

  const wrap = (line: string) =>
    formatRef.current === "rak"
      ? `+EVT:RXP2P:${(-72 + Math.random() * 6).toFixed(0)}:${(8 + Math.random() * 3).toFixed(1)}:${asciiToHex(line)}`
      : line;

  const startLoopback = useCallback(async () => {
    await stopAll();
    link.reset();
    const v = new VirtualCansat(Math.floor(Math.random() * 900) + 1);
    virtualRef.current = v;
    link.setTransport({
      async write(text: string) {
        const t = text.trim();
        if (t.startsWith("AT+PSEND=")) setTimeout(() => link.feedText("+EVT:TXP2P DONE\r\n"), 40);
        const packet = t.startsWith("AT+PSEND=") ? hexToAscii(t.slice(9)) : t.startsWith("AT+") ? null : t;
        if (!packet) return;
        const r = v.handle(packet);
        if (!r) return;
        setTimeout(() => link.feedLine(wrap(r.ack)), 250);
        if (r.exe) setTimeout(() => link.feedLine(wrap(r.exe!.line)), 250 + r.exe.delayMs);
      },
    });
    timerRef.current = setInterval(() => {
      if (pausedRef.current) return;
      for (const l of v.step(TICK * SPEED[speedRef.current])) link.feedLine(wrap(l));
    }, TICK * 1000);
    setStatus("connected");
    setLabel("virtual CanSat (loopback)");
    link.info("loopback started: virtual CanSat → decoder");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, stopAll]);

  const connectSerial = useCallback(async () => {
    if (!serialSupported()) {
      setStatus("error");
      setError("Web Serial is not available. Use Chrome or Edge on localhost or https.");
      return;
    }
    setStatus("connecting");
    setError(null);
    try {
      await stopAll();
      link.reset();
      const port = await openSerial(
        baud,
        (text) => link.feedText(text),
        (err) => {
          link.setTransport(null);
          serialRef.current = null;
          setStatus("error");
          setError(err ? `Port closed: ${err}` : "Port closed");
          link.info(`port closed${err ? `: ${err}` : ""}`);
        },
      );
      serialRef.current = port;
      setPublished(true); // the data goes to every section as soon as the port opens
      link.setTransport({ write: port.write });
      setLabel(port.label);
      setStatus("connected");
      link.info(`connected: ${port.label}`);
      if (formatRef.current === "rak") await port.write(RAK_RX + "\r\n"); // start continuous receive
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(msg.includes("No port selected") ? "idle" : "error");
      setError(msg.includes("No port selected") ? null : msg);
    }
  }, [baud, link, stopAll]);

  /** "Connect to website": show the live data in every section (opens the port first if it is not open). */
  const connectToWebsite = useCallback(async () => {
    if (serialRef.current) {
      setPublished(true);
      setLiveFrame(link.builder.frame(Date.now()));
      link.info("live data connected to the website");
    } else await connectSerial();
  }, [connectSerial, link]);

  const disconnectFromWebsite = useCallback(() => {
    setPublished(false);
    link.info("live data hidden from the website (port still logging)");
  }, [link]);

  const loadReplay = useCallback(
    async (text: string, name: string) => {
      await stopAll();
      link.reset();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      replayRef.current = { lines, idx: 0, budget: 0 };
      timerRef.current = setInterval(() => {
        const r = replayRef.current;
        if (!r || pausedRef.current) return;
        r.budget += TICK * SPEED[speedRef.current];
        while (r.idx < r.lines.length) {
          const line = r.lines[r.idx];
          const isPacket = !line.startsWith("$");
          if (isPacket && r.budget < 1) break;
          if (isPacket) r.budget -= 1;
          link.feedLine(line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, "")); // accept our own logs (UTC stamp prefix) too
          r.idx++;
        }
        if (r.idx >= r.lines.length) {
          link.info("replay finished");
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }, TICK * 1000);
      setStatus("connected");
      setLabel(`replay · ${name} · ${lines.length} lines`);
    },
    [link, stopAll],
  );

  const disconnect = useCallback(async () => {
    await stopAll();
    setStatus("idle");
    setLabel("");
    link.info("disconnected");
  }, [link, stopAll]);

  const restart = useCallback(() => {
    if (mode === "sim") sim.restart();
    else {
      link.reset();
      if (mode === "loopback") void startLoopback();
      else if (mode === "replay" && replayRef.current) replayRef.current.idx = 0;
      setLiveFrame(link.builder.frame(Date.now()));
    }
  }, [link, mode, sim, startLoopback]);

  const sendCommand = useCallback((cmd: string, cb: CmdStageCb) => link.sendCommand(cmd, cb), [link]);

  return {
    mode,
    setMode,
    status,
    error,
    label,
    baud,
    setBaud,
    format,
    setFormat: setFormatState,
    live: mode !== "sim",
    published,
    cansat: mode === "sim" ? sim.cansat : published ? liveFrame : emptyFrame,
    stopSimulation,
    startSimulation,
    connectToWebsite,
    disconnectFromWebsite,
    downloadXlsx: () =>
      downloadBytes(
        `Flight_${link.builder.teamId() || "2026-IN-SPACe-CAN-7USAT-020"}.xlsx`,
        buildSessionXlsx(link.builder, link.log),
      ),
    teamMode: link.teamMode,
    sim,
    restart,
    startLoopback,
    connectSerial,
    loadReplay,
    disconnect,
    sendCommand,
    log: link.log,
    stats: link.builder.stats(),
    fields: link.builder.snapshotFields(),
    serialSupported: serialSupported(),
    // rulebook 6.3: the file is named Flight_<TEAM_ID>.csv
    downloadCsv: () => download(`Flight_${link.builder.teamId() || "2026-IN-SPACe-CAN-7USAT-020"}.csv`, link.builder.csv()),
    downloadRawLog: () => download(`raw_link_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`, link.rawLog.join("\n") + "\n"),
  };
}
