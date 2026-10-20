import { AlertTriangle } from "lucide-react";

export type AlertType =
  | "COMMUNICATION LOST"
  | "LOW BATTERY"
  | "LOW SATELLITES"
  | "HIGH TEMPERATURE"
  | "GPS INVALID"
  | "PARACHUTE COMMAND FAILED"
  | "TELEMETRY TIMEOUT"
  | "VISION LOW SCORE"
  | "VISION DEGRADED"
  | "TARGET OUT OF REACH"
  | "PASSIVE SAFE LATCHED"
  | "WEAK LINK";

export type ActiveAlert = {
  type: AlertType;
  level: "warn" | "danger";
  source: "CANSAT" | "SYS";
  since: string;
  detail?: string;
};

export type AlertHistoryEntry = {
  id: number;
  type: AlertType;
  source: string;
  time: string;
  action: "RAISED" | "CLEARED";
};

type Props = {
  active: ActiveAlert[];
  history: AlertHistoryEntry[];
};

export function AlertsPanel({ active, history }: Props) {
  return (
    <div className="panel p-3 flex flex-col gap-2 h-full min-h-[220px]">
      <div className="flex items-center justify-between">
        <span className="label-mono">Mission Alerts</span>
        <span
          className="label-mono text-[10px]"
          style={{ color: active.length ? "var(--warn)" : "var(--ok)" }}
        >
          {active.length} active
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {active.length === 0 ? (
          <div className="rounded-md border border-border bg-[oklch(0.15_0.03_255)] px-2 py-2 label-mono text-[10px]" style={{ color: "var(--ok)" }}>
            No active alerts · all conditions nominal
          </div>
        ) : (
          active.map((a) => {
            const color = a.level === "danger" ? "var(--destructive)" : "var(--warn)";
            return (
              <div
                key={`${a.type}-${a.source}`}
                className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                style={{
                  borderColor: color,
                  background:
                    a.level === "danger"
                      ? "oklch(0.28 0.1 25 / 0.28)"
                      : "oklch(0.3 0.09 85 / 0.22)",
                }}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color }} />
                <span className="label-mono text-[10px] flex-1 truncate" style={{ color }}>
                  {a.type}
                  {a.detail ? <span className="opacity-70"> · {a.detail}</span> : null}
                </span>
                <span className="label-mono text-[9px] opacity-70">{a.source}</span>
                <span className="readout text-[10px] text-muted-foreground">{a.since}</span>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-1 flex-1 min-h-[70px] flex flex-col gap-1">
        <span className="label-mono text-[9px] opacity-60">Alert History</span>
        <div className="flex-1 overflow-auto rounded-md bg-[oklch(0.13_0.03_255)] border border-border p-2 font-mono text-[10px] space-y-0.5">
          {history.length === 0 ? (
            <div className="text-muted-foreground">No alerts recorded.</div>
          ) : (
            history.map((h) => (
              <div key={h.id} className="flex items-center gap-2">
                <span className="text-muted-foreground">{h.time}</span>
                <span
                  style={{ color: h.action === "RAISED" ? "var(--warn)" : "var(--ok)" }}
                  className="w-[52px]"
                >
                  {h.action}
                </span>
                <span className="flex-1 truncate">{h.type}</span>
                <span className="opacity-60">{h.source}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
