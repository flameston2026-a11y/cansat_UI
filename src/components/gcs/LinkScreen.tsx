import { useRef } from "react";
import { Download, PlugZap, Unplug, Upload } from "lucide-react";
import type { useGroundLink, SourceMode } from "./comm/useGroundLink";
import { LND_FIELDS, TLM_FIELDS, csvCell, type FieldDef, type Values } from "./comm/protocol";
import type { LogTag } from "./comm/groundLink";
import { PanelTitle, StatusChip } from "./Kit";

type Link = ReturnType<typeof useGroundLink>;

const MODES: { id: SourceMode; name: string; note: string }[] = [
  { id: "sim", name: "Simulator", note: "Built-in flight simulation. No hardware." },
  { id: "loopback", name: "Loopback test", note: "A virtual CanSat sends real protocol packets through the real decoder." },
  { id: "serial", name: "Serial (live)", note: "The ground LoRa receiver on a USB port. Chrome or Edge." },
  { id: "replay", name: "Replay log", note: "Play back a recorded log or CSV file." },
];

const TAG_COLOR: Record<LogTag, string> = {
  TLM: "var(--cansat)",
  LND: "oklch(0.74 0.12 300)",
  EVT: "var(--event)",
  ACK: "var(--ok)",
  EXE: "var(--ok)",
  BAD: "var(--destructive)",
  AT: "oklch(0.72 0.03 250)",
  TX: "var(--warn)",
  SYS: "oklch(0.72 0.03 250)",
};

export function LinkScreen({ link }: { link: Link }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { mode, status, stats } = link;
  const live = mode !== "sim";
  const statusChip = status === "connected" ? "OK" : status === "error" ? "FAIL" : status === "connecting" ? "WARN" : "OFF";
  const age = link.fields.tlmAt ? ((Date.now() - link.fields.tlmAt) / 1000).toFixed(1) : "—";

  return (
    <div className="h-full overflow-y-auto scroll-thin p-4 flex flex-col gap-4">
      {/* source */}
      <div className="panel p-3 flex flex-col gap-3">
        <PanelTitle
          title="Data Source"
          icon={<PlugZap className="h-3.5 w-3.5" />}
          right={<StatusChip status={statusChip} text={`${status.toUpperCase()}${link.label ? ` · ${link.label}` : ""}`} />}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => void link.setMode(m.id)}
              className="well p-3 text-left flex flex-col gap-1 hover:bg-[oklch(0.2_0.04_255)]"
              style={{ borderColor: mode === m.id ? "var(--cansat)" : undefined }}
            >
              <span className="label-mono text-[10px]" style={{ color: mode === m.id ? "var(--cansat)" : "oklch(0.9 0.03 250)" }}>
                {m.name}
              </span>
              <span className="text-[11px] opacity-70 leading-snug">{m.note}</span>
            </button>
          ))}
        </div>

        {mode === "serial" ? (
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="label-mono text-[9px]">Baud rate</span>
              <select
                value={link.baud}
                onChange={(e) => link.setBaud(Number(e.target.value))}
                className="well px-2 py-1.5 readout text-sm"
                disabled={status === "connected"}
              >
                {[9600, 19200, 38400, 57600, 115200, 230400, 460800].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="label-mono text-[9px]">Receiver output</span>
              <select
                value={link.format}
                onChange={(e) => link.setFormat(e.target.value as "raw" | "rak")}
                className="well px-2 py-1.5 readout text-sm"
              >
                <option value="rak">RAK3272S AT mode (+EVT:RXP2P)</option>
                <option value="raw">Raw packet lines</option>
              </select>
            </label>
            {status === "connected" ? (
              <button onClick={() => void link.disconnect()} className="panel px-3 py-2 label-mono text-[10px] flex items-center gap-1.5">
                <Unplug className="h-3.5 w-3.5" /> Disconnect
              </button>
            ) : (
              <button
                onClick={() => void link.connectSerial()}
                className="panel px-3 py-2 label-mono text-[10px] flex items-center gap-1.5"
                style={{ borderColor: "var(--cansat)", color: "var(--cansat)" }}
              >
                <PlugZap className="h-3.5 w-3.5" /> Connect to port
              </button>
            )}
            {!link.serialSupported ? (
              <span className="text-[11px]" style={{ color: "var(--warn)" }}>
                This browser has no Web Serial. Use Chrome or Edge.
              </span>
            ) : null}
          </div>
        ) : null}

        {mode === "loopback" ? (
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="label-mono text-[9px]">Packet wrapping</span>
              <select value={link.format} onChange={(e) => link.setFormat(e.target.value as "raw" | "rak")} className="well px-2 py-1.5 readout text-sm">
                <option value="raw">Raw packet lines</option>
                <option value="rak">RAK3272S AT mode (+EVT:RXP2P)</option>
              </select>
            </label>
            <button
              onClick={() => void link.startLoopback()}
              className="panel px-3 py-2 label-mono text-[10px]"
              style={{ borderColor: "var(--cansat)", color: "var(--cansat)" }}
            >
              {status === "connected" ? "Restart loopback" : "Start loopback"}
            </button>
            {status === "connected" ? (
              <button onClick={() => void link.disconnect()} className="panel px-3 py-2 label-mono text-[10px]">
                Stop
              </button>
            ) : null}
          </div>
        ) : null}

        {mode === "replay" ? (
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.log,.txt"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) await link.loadReplay(await f.text(), f.name);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="panel px-3 py-2 label-mono text-[10px] flex items-center gap-1.5"
              style={{ borderColor: "var(--cansat)", color: "var(--cansat)" }}
            >
              <Upload className="h-3.5 w-3.5" /> Choose log file
            </button>
            <span className="text-[11px] opacity-70">
              Plays at the speed chosen in the top bar. Accepts the CSV from this app, raw link logs, or plain packet lines.
            </span>
          </div>
        ) : null}

        {link.error ? (
          <div className="text-[12px] rounded px-3 py-2" style={{ background: "oklch(0.28 0.1 25 / 0.4)", color: "oklch(0.92 0.06 30)" }}>
            {link.error}
          </div>
        ) : null}
      </div>

      {/* statistics */}
      {live ? (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
          <Tile k="Packets received" v={String(stats.received)} />
          <Tile k="Lost (count gaps)" v={String(stats.lost)} warn={stats.lost > 0} />
          <Tile k="Checksum errors" v={String(stats.crc)} warn={stats.crc > 0} />
          <Tile k="Format errors" v={String(stats.parseErrors)} warn={stats.parseErrors > 0} />
          <Tile k="Last packet" v={age === "—" ? "—" : `${age} s ago`} />
          <Tile k="Rate" v={Number.isFinite(link.cansat.updateRate) ? `${link.cansat.updateRate.toFixed(1)} Hz` : "—"} />
        </div>
      ) : (
        <div className="well p-3 text-[12px] opacity-80">
          The simulator is active, so there is no link traffic to show. Choose Loopback test to watch real protocol packets
          being decoded, or Serial to connect the ground receiver.
        </div>
      )}

      {live ? (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-4">
          {/* monitor */}
          <div className="panel p-3 flex flex-col gap-2 min-h-[320px]">
            <PanelTitle
              title="Packet Monitor"
              right={
                <div className="flex gap-1.5">
                  <button onClick={link.downloadCsv} className="panel px-2 py-1 label-mono text-[9px] flex items-center gap-1">
                    <Download className="h-3 w-3" /> Flight CSV
                  </button>
                  <button onClick={link.downloadRawLog} className="panel px-2 py-1 label-mono text-[9px] flex items-center gap-1">
                    <Download className="h-3 w-3" /> Raw log
                  </button>
                </div>
              }
            />
            <div className="well flex-1 overflow-y-auto scroll-thin max-h-[420px] p-1.5 flex flex-col-reverse">
              <div className="flex flex-col gap-px">
                {link.log.slice(-120).map((e) => (
                  <div key={e.id} className="flex gap-2 items-baseline text-[10.5px] leading-snug font-mono">
                    <span className="opacity-50 shrink-0">{new Date(e.at).toISOString().slice(11, 19)}</span>
                    <span className="w-8 shrink-0 font-bold" style={{ color: TAG_COLOR[e.tag] }}>
                      {e.tag}
                    </span>
                    <span className="break-all">{e.text}</span>
                    {e.note ? (
                      <span className="shrink-0" style={{ color: e.tag === "BAD" ? "var(--destructive)" : "var(--warn)" }}>
                        {e.note}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* field table */}
          <div className="panel p-3 flex flex-col gap-2">
            <PanelTitle title="Latest Decoded Fields" />
            <div className="well p-2 overflow-y-auto scroll-thin max-h-[420px]">
              <FieldTable title="Telemetry (16 mandatory fields)" defs={TLM_FIELDS} values={link.fields.tlm} />
              <FieldTable title="Landing-logic extension ($LND)" defs={LND_FIELDS} values={link.fields.lnd} />
            </div>
          </div>
        </div>
      ) : null}

      {/* setup notes */}
      <div className="panel p-3 flex flex-col gap-1.5">
        <PanelTitle title="Ground receiver setup (RAK3272S, via PuTTY once)" />
        <pre className="well p-2.5 text-[11px] leading-relaxed overflow-x-auto font-mono opacity-90">{`AT+NWM=0                          (LoRa P2P mode)
AT+P2P=865250000:9:125:0:8:10    (frequency:SF:BW:CR:preamble:power)
AT+PRECV=65534                    (continuous receive; this app re-sends it after every transmit)`}</pre>
        <p className="text-[10.5px] opacity-60 leading-snug">
          Team 020 assignment: single channel 865.25 MHz (no backup), SF9, 125 kHz, coding rate 4/5, LoRa P2P sync word 0x54, about +10 dBm
          on the pad and +14 dBm in flight. The CanSat and this receiver must match exactly. Set the sync word with the module's
          sync-word command (check the RUI3 manual for your firmware's exact syntax), and confirm the preamble (8 shown) and the
          AT+P2P argument format against your firmware version. The receive format (+EVT:RXP2P:rssi:snr:hex) has been confirmed with a real packet.
          Bench-test lines like ALT=100.0,TEMP=28.0,VBAT=18.50 are also shown, marked as test data.
        </p>
      </div>
    </div>
  );
}

function Tile({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="well px-2.5 py-2 flex flex-col gap-0.5">
      <span className="label-mono text-[9px]">{k}</span>
      <span className="readout text-lg" style={{ color: warn ? "var(--warn)" : undefined }}>
        {v}
      </span>
    </div>
  );
}

function FieldTable({ title, defs, values }: { title: string; defs: FieldDef[]; values: Values | null }) {
  return (
    <div className="mb-2">
      <div className="label-mono text-[9px] mb-1" style={{ color: "oklch(0.86 0.04 250)" }}>
        {title}
      </div>
      {defs.map((d) => {
        const raw = values ? values[d.key] : undefined;
        const missing = raw === undefined || (typeof raw === "number" && Number.isNaN(raw));
        return (
          <div key={d.key} className="flex items-baseline justify-between gap-3 py-[2px] border-b border-border/30 last:border-0">
            <span className="label-mono text-[9px] truncate">{d.label}</span>
            <span className="readout text-[11.5px] shrink-0" style={{ color: missing ? "oklch(0.55 0.02 250)" : undefined }}>
              {missing ? (raw === undefined ? "—" : "invalid") : csvCell(d, raw)}
              {!missing && d.unit ? <span className="label-mono text-[8.5px] ml-1">{d.unit}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
