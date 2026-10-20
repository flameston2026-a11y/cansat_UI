import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import { Header, type SystemStatus } from "@/components/gcs/Header";
import { StatusFooter } from "@/components/gcs/StatusFooter";
import { TrajectoryScreen } from "@/components/gcs/TrajectoryScreen";
import { FlightParamsScreen } from "@/components/gcs/FlightParamsScreen";
import { LivePlots } from "@/components/gcs/LivePlots";
import { ParameterBox } from "@/components/gcs/ParameterBox";
import { SensorsPanel } from "@/components/gcs/SensorsPanel";
import { LandingPanel } from "@/components/gcs/LandingPanel";
import { HealthLinkPanel } from "@/components/gcs/HealthLinkPanel";
import { CommandsPanel } from "@/components/gcs/CommandsPanel";
import {
  AlertsPanel,
  type ActiveAlert,
  type AlertHistoryEntry,
  type AlertType,
} from "@/components/gcs/AlertsPanel";
import { CommandConsole, type ConsoleEntry } from "@/components/gcs/CommandConsole";
import type { CmdStage } from "@/components/gcs/CommandButton";
import type { CommandResult, PlaybackSpeed } from "@/components/gcs/telemetry";
import { useGroundLink } from "@/components/gcs/comm/useGroundLink";
import { LinkScreen } from "@/components/gcs/LinkScreen";
import { installSafeNumber } from "@/components/gcs/comm/safeNumber";
import { MISSION_ID, SITE_NAME } from "@/components/gcs/mission";

installSafeNumber(); // unknown values print as a dash instead of NaN (see safeNumber.ts)

export const Route = createFileRoute("/")({
  component: GroundStation,
  head: () => ({
    meta: [
      { title: "Mission Ground Station · CanSat Telemetry" },
      {
        name: "description",
        content:
          "CanSat ground station: descent trajectory, flight graphs, sensor panels, landing-logic status, health, signal and command console.",
      },
      { property: "og:title", content: "Mission Ground Station · CanSat Telemetry" },
      {
        property: "og:description",
        content:
          "Real-time CanSat telemetry, trajectory, error tracking, health and command uplink for a CanSat competition flight.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

type ScreenId = "trajectory" | "params" | "plots" | "sensors" | "landing" | "health" | "commands" | "link";
const SCREENS: { id: ScreenId; label: string }[] = [
  { id: "trajectory", label: "Trajectory" },
  { id: "params", label: "Flight Parameters" },
  { id: "plots", label: "Telemetry Plots" },
  { id: "sensors", label: "Sensors" },
  { id: "landing", label: "Landing Logic" },
  { id: "health", label: "Health & Signal" },
  { id: "commands", label: "Commands & Alerts" },
  { id: "link", label: "Data Link" },
];

function GroundStation() {
  const [speed, setSpeed] = useState<PlaybackSpeed>("5x");
  const [paused, setPaused] = useState(false);
  const link = useGroundLink(speed, paused);
  const { cansat, restart } = link;
  const { assistOff, setTarget } = link.sim;
  const [screen, setScreen] = useState<ScreenId>("trajectory");
  const [drawer, setDrawer] = useState(false);
  const [stateTimes, setStateTimes] = useState<Record<string, string>>({});
  // the last CXON / CXOFF the CanSat confirmed (live modes)
  const [txCommanded, setTxCommanded] = useState<"ON" | "OFF" | null>(null);
  // alert limits the operator can change
  const [minVolt, setMinVolt] = useState(7.0);
  const [minSats, setMinSats] = useState(5);

  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const nextId = useRef(1);

  // ---- Command lifecycle -------------------------------------------------
  const [parachuteFail, setParachuteFail] = useState(false);
  const raiseParachuteFailure = () => {
    setParachuteFail(true);
    setTimeout(() => setParachuteFail(false), 12000);
  };

  const pushCommand = (
    channel: ConsoleEntry["channel"],
    cmd: string,
    onStage?: (stage: CmdStage) => void,
    run?: () => CommandResult,
  ) => {
    const id = nextId.current++;
    setEntries((e) =>
      [...e, { id, t: stamp(), channel, cmd, ack: "PENDING" as const, exec: "PENDING" as const }].slice(-80),
    );
    onStage?.("SENT");

    const acked = run ? true : Math.random() > 0.06;
    setTimeout(
      () => {
        setEntries((e) => e.map((x) => (x.id === id ? { ...x, ack: acked ? "ACK" : "NAK" } : x)));
        onStage?.(acked ? "ACK" : "NAK");
        if (!acked) {
          setEntries((e) => e.map((x) => (x.id === id ? { ...x, exec: "FAIL" } : x)));
          if (cmd.startsWith("DEPLOY")) raiseParachuteFailure();
          return;
        }
        setTimeout(
          () => {
            const result = run ? run() : undefined;
            const passed = result ? result.ok : Math.random() > 0.08;
            setEntries((e) =>
              e.map((x) =>
                x.id === id ? { ...x, exec: passed ? "PASS" : "FAIL", note: result?.reason } : x,
              ),
            );
            onStage?.(passed ? "PASS" : "FAIL");
            if (!passed && cmd.startsWith("DEPLOY")) raiseParachuteFailure();
          },
          500 + Math.random() * 500,
        );
      },
      400 + Math.random() * 400,
    );
  };

  // Live modes: the command goes out over the link and the real ACK/NAK and
  // PASS/FAIL replies drive the console. Simulator mode keeps the simulated flow.
  const pushLive = (cmd: string, onStage?: (stage: CmdStage) => void) => {
    const id = nextId.current++;
    setEntries((e) =>
      [...e, { id, t: stamp(), channel: "CANSAT" as const, cmd, ack: "PENDING" as const, exec: "PENDING" as const }].slice(-80),
    );
    onStage?.("SENT");
    link.sendCommand(cmd, (stage, reason) => {
      setEntries((e) =>
        e.map((x) => {
          if (x.id !== id) return x;
          if (stage === "ACK") return { ...x, ack: "ACK" as const };
          if (stage === "NAK") return { ...x, ack: "NAK" as const, exec: "FAIL" as const, note: reason };
          return { ...x, exec: stage, note: reason };
        }),
      );
      onStage?.(stage);
      if (stage === "PASS") {
        if (cmd.startsWith("START_TRANSMISSION") || cmd.startsWith("CXON")) setTxCommanded("ON");
        if (cmd.startsWith("STOP_TELEMETRY") || cmd.startsWith("CXOFF")) setTxCommanded("OFF");
      }
      if ((stage === "FAIL" || stage === "NAK") && cmd.startsWith("DEPLOY")) raiseParachuteFailure();
    });
  };

  const onCommand = (c: string, onStage: (s: CmdStage) => void) =>
    link.live ? pushLive(c, onStage) : pushCommand("CANSAT", c, onStage, c === "ASSIST_OFF" ? assistOff : undefined);

  const onSetTarget = (lat: number, lon: number, onStage: (s: CmdStage) => void) =>
    link.live
      ? pushLive(`SET_TARGET ${lat.toFixed(5)},${lon.toFixed(5)}`, onStage)
      : pushCommand("CANSAT", `SET_TARGET ${lat.toFixed(5)},${lon.toFixed(5)}`, onStage, () => setTarget(lat, lon));

  // ---- Alerts ------------------------------------------------------------
  const now = Date.now();
  const conditions = useMemo(() => {
    const list: {
      type: AlertType;
      level: "warn" | "danger";
      source: ActiveAlert["source"];
      detail?: string;
    }[] = [];
    const stale = !paused && cansat.lastPacketAt > 0 && now - cansat.lastPacketAt > 3000;
    if (cansat.linkQuality < 58 || cansat.rssi < -100)
      list.push({ type: "COMMUNICATION LOST", level: "danger", source: "CANSAT" });
    if (stale) list.push({ type: "TELEMETRY TIMEOUT", level: "danger", source: "CANSAT" });
    if (cansat.ina.busV < minVolt)
      list.push({ type: "LOW BATTERY", level: "warn", source: "CANSAT", detail: `${cansat.ina.busV.toFixed(2)} V` });
    if (cansat.gnss.sats < minSats)
      list.push({ type: "LOW SATELLITES", level: "warn", source: "CANSAT", detail: `${cansat.gnss.sats} sats` });
    if (cansat.sht.temp > 45)
      list.push({ type: "HIGH TEMPERATURE", level: "warn", source: "CANSAT", detail: `${cansat.sht.temp.toFixed(1)} °C` });
    if (cansat.gnss.fix !== "3D") list.push({ type: "GPS INVALID", level: "warn", source: "CANSAT" });
    for (const fault of cansat.faults) {
      if (
        fault === "VISION LOW SCORE" ||
        fault === "VISION DEGRADED" ||
        fault === "TARGET OUT OF REACH" ||
        fault === "WEAK LINK"
      )
        list.push({ type: fault, level: "warn", source: "CANSAT" });
      if (fault === "PASSIVE SAFE LATCHED")
        list.push({ type: "PASSIVE SAFE LATCHED", level: "danger", source: "CANSAT" });
    }
    if (parachuteFail) list.push({ type: "PARACHUTE COMMAND FAILED", level: "danger", source: "SYS" });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cansat.linkQuality,
    cansat.rssi,
    cansat.ina.busV,
    cansat.gnss.sats,
    minVolt,
    minSats,
    cansat.sht.temp,
    cansat.gnss.fix,
    cansat.faults.join("|"),
    cansat.lastPacketAt,
    parachuteFail,
    paused,
    now,
  ]);

  const [activeAlerts, setActiveAlerts] = useState<ActiveAlert[]>([]);
  const [alertHistory, setAlertHistory] = useState<AlertHistoryEntry[]>([]);
  const alertId = useRef(1);
  useEffect(() => {
    setActiveAlerts((prev) => {
      const key = (a: { type: string; source: string }) => `${a.type}|${a.source}`;
      const prevMap = new Map(prev.map((a) => [key(a), a]));
      const next: ActiveAlert[] = conditions.map((c) => {
        const existing = prevMap.get(key(c));
        return existing ? { ...existing, detail: c.detail } : { ...c, since: stamp() };
      });
      const nextKeys = new Set(next.map(key));
      const added = next.filter((a) => !prevMap.has(key(a)));
      const removed = prev.filter((a) => !nextKeys.has(key(a)));
      if (added.length || removed.length) {
        setAlertHistory((h) =>
          [
            ...h,
            ...added.map((a) => ({ id: alertId.current++, type: a.type, source: a.source, time: stamp(), action: "RAISED" as const })),
            ...removed.map((a) => ({ id: alertId.current++, type: a.type, source: a.source, time: stamp(), action: "CLEARED" as const })),
          ].slice(-60),
        );
      }
      return added.length || removed.length ? next : prev;
    });
  }, [conditions]);

  // ---- Header data -------------------------------------------------------
  useEffect(() => {
    setStateTimes((prev) =>
      cansat.state === "STANDBY" ? { STANDBY: stamp() } : prev[cansat.state] ? prev : { ...prev, [cansat.state]: stamp() },
    );
  }, [cansat.state]);

  const missionPhase = useMemo(() => {
    switch (cansat.landing) {
      case "IDLE":
        return "PRE-SEPARATION";
      case "L0":
        return "PARACHUTE DESCENT";
      case "L1":
      case "L2":
        return "ARMS DEPLOY";
      case "L9":
        return "PASSIVE SAFE DESCENT";
      case "L10":
        return cansat.state === "MISSION_COMPLETE" ? "MISSION COMPLETE" : "LANDED · RECOVERY";
      default:
        return `CONTROLLED DESCENT · ${cansat.landingName}`;
    }
  }, [cansat.landing, cansat.landingName, cansat.state]);

  const systemStatus: SystemStatus = activeAlerts.some((a) => a.level === "danger")
    ? "CRITICAL"
    : activeAlerts.length > 0
      ? "DEGRADED"
      : "NOMINAL";

  const alert = useMemo(() => {
    const danger = activeAlerts.find((a) => a.level === "danger");
    if (danger) return { level: "danger" as const, message: `${danger.type} · ${danger.source}` };
    const warn = activeAlerts[0];
    if (warn) return { level: "warn" as const, message: `${warn.type} · ${warn.source}` };
    if (cansat.state === "MISSION_COMPLETE") return { level: "info" as const, message: "MISSION COMPLETE" };
    return { level: "info" as const, message: "SIMULATION MODE · TELEMETRY NOMINAL" };
  }, [activeAlerts, cansat.state]);

  const ageS = paused ? 0 : Math.max(0, (now - cansat.lastPacketAt) / 1000);
  const linkStatus = ageS > 3 ? "LOST" : cansat.linkQuality < 70 ? "DEGRADED" : "CONNECTED";

  const tx: "ON" | "OFF" | "SILENT" = !link.live
    ? "ON"
    : ageS <= 3
      ? "ON"
      : txCommanded === "OFF"
        ? "OFF"
        : "SILENT";

  const navBtn = (id: ScreenId, label: string) => (
    <button
      key={id}
      onClick={() => setScreen(id)}
      className="px-3 py-1.5 rounded label-mono text-[10px] whitespace-nowrap border transition-colors"
      style={{
        borderColor: screen === id ? "var(--cansat)" : "transparent",
        background: screen === id ? "oklch(0.27 0.07 235 / 0.7)" : undefined,
        color: screen === id ? "oklch(0.98 0 0)" : undefined,
      }}
    >
      {label}
    </button>
  );

  const controls = (
    <>
      <span className="label-mono text-[8.5px] mr-1 opacity-70 hidden xl:inline">SIMULATED PLAYBACK</span>
      {(["1x", "5x", "10x"] as const).map((sp) => (
        <button
          key={sp}
          onClick={() => setSpeed(sp)}
          className="panel px-2 py-1 label-mono text-[9.5px] hover:bg-[oklch(0.25_0.045_255)]"
          style={{ borderColor: speed === sp ? "var(--cansat)" : undefined, color: speed === sp ? "var(--cansat)" : undefined }}
        >
          {sp}
        </button>
      ))}
      <button
        onClick={() => setPaused((p) => !p)}
        className="panel px-2 py-1 label-mono text-[9.5px] flex items-center gap-1 hover:bg-[oklch(0.25_0.045_255)]"
        style={{ color: paused ? "var(--warn)" : undefined }}
      >
        {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        {paused ? "Resume" : "Pause"}
      </button>
      <button
        onClick={restart}
        className="panel px-2 py-1 label-mono text-[9.5px] flex items-center gap-1 hover:bg-[oklch(0.25_0.045_255)]"
      >
        <RotateCcw className="h-3 w-3" /> Restart
      </button>
    </>
  );

  const scrollPage = "h-full overflow-y-auto scroll-thin p-4";

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header
        missionId={MISSION_ID}
        launchSite={SITE_NAME}
        met={cansat.met}
        missionPhase={missionPhase}
        cansatState={cansat.state}
        systemStatus={systemStatus}
        alert={alert}
        link={{
          status: linkStatus,
          text: `${link.live ? link.mode.toUpperCase() : "SIMULATED"} · ${cansat.rssi.toFixed(0)} dBm · SNR ${cansat.snr.toFixed(1)} dB`,
        }}
        tx={tx}
        txShutdownIn={cansat.txShutdownIn}
        nav={SCREENS.map((s) => navBtn(s.id, s.label))}
        controls={controls}
      />

      <main className="flex-1 min-h-0 relative">
        {screen === "trajectory" ? (
          <TrajectoryScreen f={cansat} missionTitle="FLAMESTON-26 / TEAM 020 · CANSAT MISSION" />
        ) : null}
        {screen === "params" ? <FlightParamsScreen f={cansat} /> : null}
        {screen === "plots" ? <LivePlots f={cansat} /> : null}
        {screen === "sensors" ? (
          <div className={scrollPage}>
            <SensorsPanel f={cansat} />
          </div>
        ) : null}
        {screen === "landing" ? (
          <div className={scrollPage}>
            <LandingPanel f={cansat} />
          </div>
        ) : null}
        {screen === "health" ? (
          <div className={scrollPage}>
            <HealthLinkPanel f={cansat} />
          </div>
        ) : null}
        {screen === "commands" ? (
          <div className={`${scrollPage} flex flex-col gap-4`}>
            <CommandsPanel f={cansat} onCommand={onCommand} onSetTarget={onSetTarget} />
            <div className="panel p-3 flex flex-wrap items-center gap-x-6 gap-y-2">
              <span className="label-mono text-[10px]">Alert limits</span>
              <label className="flex items-center gap-2 text-[12px]">
                Low battery below
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={minVolt}
                  onChange={(e) => setMinVolt(Number(e.target.value) || 0)}
                  className="w-16 rounded border bg-transparent px-1.5 py-0.5 readout"
                />
                V
              </label>
              <label className="flex items-center gap-2 text-[12px]">
                Low satellites below
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={minSats}
                  onChange={(e) => setMinSats(Number(e.target.value) || 0)}
                  className="w-14 rounded border bg-transparent px-1.5 py-0.5 readout"
                />
              </label>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <AlertsPanel active={activeAlerts} history={alertHistory} />
              <CommandConsole entries={entries} />
            </div>
          </div>
        ) : null}

        {screen === "link" ? <LinkScreen link={link} /> : null}

        {/* slide-over: the complete parameter box */}
        {drawer ? (
          <aside
            className="absolute right-0 top-0 bottom-0 z-30 w-[min(420px,100%)] overflow-y-auto scroll-thin p-3 border-l shadow-2xl"
            style={{ background: "oklch(0.13 0.03 257 / 0.97)" }}
          >
            <button
              onClick={() => setDrawer(false)}
              className="absolute right-3 top-3 z-10 panel p-1 hover:bg-[oklch(0.25_0.045_255)]"
              aria-label="Close parameter box"
            >
              <X className="h-4 w-4" />
            </button>
            <ParameterBox f={cansat} />
          </aside>
        ) : null}
      </main>

      <StatusFooter f={cansat} stateTimes={stateTimes} alertCount={activeAlerts.length} onParams={() => setDrawer((d) => !d)} />
    </div>
  );
}
