import { useEffect, useState, type ReactNode } from "react";

export type MissionEvent = { label: string; time: string };
export type SystemStatus = "NOMINAL" | "DEGRADED" | "CRITICAL";

type Props = {
  missionId: string;
  launchSite: string;
  met: number; // mission elapsed time, seconds since separation (negative before)
  missionPhase: string;
  cansatState: string;
  systemStatus: SystemStatus;
  alert?: { level: "info" | "warn" | "danger"; message: string } | null;
  link: { status: "CONNECTED" | "DEGRADED" | "LOST"; text: string };
  /** telemetry transmitter state as the operator sees it */
  tx: "ON" | "OFF" | "SILENT";
  /** seconds until the automatic transmission stop (90 min after launch detect); null before launch */
  txShutdownIn: number | null;
  nav: ReactNode;
  controls: ReactNode;
};

const STATUS_COLOR: Record<SystemStatus, string> = {
  NOMINAL: "var(--ok)",
  DEGRADED: "var(--warn)",
  CRITICAL: "var(--destructive)",
};
const LINK_COLOR = { CONNECTED: "var(--ok)", DEGRADED: "var(--warn)", LOST: "var(--destructive)" } as const;

const TX_COLOR = { ON: "var(--ok)", OFF: "var(--warn)", SILENT: "var(--destructive)" } as const;
const mmss = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

const hms = (d: Date) => d.toISOString().slice(11, 19);

function Clock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="clock-digits text-[clamp(20px,2.3vw,36px)] leading-none">{value}</span>
      <span className="isro-serif text-[clamp(12px,1.2vw,18px)]" style={{ color: "oklch(0.82 0.2 145)" }}>
        {label}
      </span>
    </div>
  );
}

function Item({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="label-mono text-[8.5px]">{k}</span>
      {children}
    </div>
  );
}

export function Header({
  missionId,
  launchSite,
  met,
  missionPhase,
  cansatState,
  systemStatus,
  alert,
  link,
  tx,
  txShutdownIn,
  nav,
  controls,
}: Props) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  const utc = now ? hms(now) : "--:--:--";
  const ist = now ? hms(new Date(now.getTime() + 5.5 * 3600 * 1000)) : "--:--:--";
  const metTxt = `${met < 0 ? "T−" : "T+"}${Math.abs(met).toFixed(0).padStart(3, "0")}`;
  const alertColor =
    alert?.level === "danger" ? "var(--destructive)" : alert?.level === "warn" ? "var(--warn)" : "var(--ok)";

  return (
    <header className="shrink-0 border-b" style={{ background: "oklch(0.1 0.03 258)" }}>
      {/* row 1: clocks and mission identity */}
      <div className="px-4 py-1.5 flex items-center gap-x-8 gap-y-1 flex-wrap">
        <Clock label="IST" value={ist} />
        <Clock label="UTC" value={utc} />
        <Clock label="MET" value={metTxt} />
        <div className="ml-auto text-right leading-tight">
          <div className="isro-serif text-[clamp(13px,1.3vw,20px)]" style={{ color: "oklch(0.9 0.15 100)" }}>
            {missionId}
          </div>
          <div className="label-mono text-[9px]">{launchSite}</div>
        </div>
      </div>

      {/* row 2: navigation, state items, controls */}
      <div className="px-3 py-1.5 flex items-center gap-x-5 gap-y-1.5 flex-wrap border-t" style={{ background: "oklch(0.15 0.04 256)" }}>
        <div className="flex gap-1">{nav}</div>

        <div className="hidden lg:block h-7 w-px bg-border" />
        <Item k="Mission phase">
          <span className="readout text-[12px]" style={{ color: "var(--cansat)" }}>
            {missionPhase}
          </span>
        </Item>
        <Item k="CanSat state">
          <span className="readout text-[12px]">{cansatState.replace(/_/g, " ")}</span>
        </Item>
        <Item k="System">
          <span className="readout text-[12px]" style={{ color: STATUS_COLOR[systemStatus] }}>
            {systemStatus}
          </span>
        </Item>
        <Item k="CanSat ↔ ground LoRa">
          <span className="readout text-[12px]" style={{ color: LINK_COLOR[link.status] }}>
            {link.status} <span className="opacity-70 text-[10.5px]">{link.text}</span>
          </span>
        </Item>

        <Item k="Telemetry TX">
          <span className="readout text-[12px]" style={{ color: TX_COLOR[tx] }}>
            {tx}
          </span>
        </Item>
        <Item k="Auto-shutdown (90 min)">
          <span
            className="readout text-[12px]"
            style={{ color: txShutdownIn !== null && txShutdownIn < 300 ? "var(--warn)" : undefined }}
            title="The rulebook requires transmission to stop 90 minutes after launch detect"
          >
            {txShutdownIn === null ? "WAITING FOR LAUNCH" : `T−${mmss(txShutdownIn)}`}
          </span>
        </Item>

        <div
          className={`flex items-center gap-2 rounded px-2.5 py-1 border ${alert?.level === "danger" ? "master-blink" : ""}`}
          style={{ borderColor: alertColor, background: "oklch(0.14 0.035 255)" }}
          title="Master alert"
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: alertColor, boxShadow: `0 0 8px ${alertColor}` }} />
          <span className="label-mono text-[9.5px]" style={{ color: alertColor, letterSpacing: "0.1em" }}>
            {alert && alert.level !== "info" ? `⚠ ${alert.message}` : (alert?.message ?? "ALL CLEAR")}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">{controls}</div>
      </div>
    </header>
  );
}
