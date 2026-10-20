import { Activity, Radio } from "lucide-react";
import type { CansatFrame } from "./telemetry";
import { SeriesChart } from "./SeriesChart";
import { Bar, KV, PanelTitle, Stat, StatusChip, STATUS_COLOR, f0, f1, f2 } from "./Kit";

const CYAN = "oklch(0.82 0.12 210)";
const GREEN = "oklch(0.78 0.15 155)";
const YELLOW = "oklch(0.88 0.15 98)";
const RED = "oklch(0.72 0.19 35)";

export function HealthLinkPanel({ f }: { f: CansatFrame }) {
  const ageS = Math.max(0, (Date.now() - f.lastPacketAt) / 1000);
  const rx = Math.max(0, f.packetCount - f.packetsLost);
  const lossPct = f.packetCount > 0 ? (f.packetsLost / f.packetCount) * 100 : 0;
  const linkStatus = ageS > 3 ? "LOST" : f.linkQuality < 70 ? "DEGRADED" : "CONNECTED";
  const linkColor = linkStatus === "CONNECTED" ? GREEN : linkStatus === "DEGRADED" ? YELLOW : RED;
  const warn = f.health.filter((h) => h.status === "WARN" || h.status === "FAIL").length;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
      {/* HEALTH */}
      <div className="panel p-3 flex flex-col gap-3">
        <PanelTitle
          title="CanSat Health"
          icon={<Activity className="h-3.5 w-3.5" />}
          right={<StatusChip status={warn ? "WARN" : "OK"} text={warn ? `${warn} WARNING` : "ALL SYSTEMS NOMINAL"} />}
        />
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {f.health.map((h) => (
            <div key={h.name} className="well px-2.5 py-2 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="label-mono text-[9.5px] truncate">{h.name}</span>
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ background: STATUS_COLOR[h.status], boxShadow: h.status === "OK" ? `0 0 6px ${STATUS_COLOR.OK}` : undefined }}
                />
              </div>
              <span className="readout text-[11px] truncate">{h.detail}</span>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="well p-2.5 flex flex-col gap-2">
            <span className="label-mono text-[9px]">Electronics bus</span>
            <div className="flex items-baseline gap-1">
              <span className="readout text-2xl">{f2(f.ina.busV)}</span>
              <span className="label-mono text-[10px]">V</span>
            </div>
            <Bar value={f.ina.busV} min={6.0} max={8.4} mark={7.0} color={f.ina.busV < 7.0 ? RED : GREEN} height={7} />
            <KV k="Current" v={f0(f.ina.currentMA)} unit="mA" />
            <KV k="Power" v={f2(f.ina.powerMW / 1000)} unit="W" />
          </div>
          <div className="well p-2.5 flex flex-col gap-2">
            <span className="label-mono text-[9px]">Thermal and motion</span>
            <div className="flex items-baseline gap-1">
              <span className="readout text-2xl">{f1(f.sht.temp)}</span>
              <span className="label-mono text-[10px]">°C</span>
            </div>
            <Bar value={f.sht.temp} min={0} max={60} mark={45} color={f.sht.temp > 45 ? RED : CYAN} height={7} />
            <KV k="Humidity" v={f1(f.sht.rh)} unit="%" />
            <KV k="Tilt" v={f1(Math.hypot(f.imu.roll, f.imu.pitch))} unit="°" />
          </div>
        </div>
        <p className="text-[10.5px] leading-snug opacity-60">
          The INA219 measures the electronics rail only. Motor-pack current is shown as the thrust estimate, since the
          INA219 range cannot cover motor current.
        </p>
      </div>

      {/* SIGNAL */}
      <div className="panel p-3 flex flex-col gap-3">
        <PanelTitle
          title="Signal and Data Link"
          icon={<Radio className="h-3.5 w-3.5" />}
          right={<StatusChip status={linkStatus === "CONNECTED" ? "OK" : linkStatus === "DEGRADED" ? "WARN" : "FAIL"} text={linkStatus} />}
        />
        <div className="grid grid-cols-3 gap-2">
          <div className="well p-2.5 flex flex-col gap-1.5">
            <span className="label-mono text-[9px]">RSSI</span>
            <span className="readout text-xl">{f0(f.rssi)} <span className="label-mono text-[9px]">dBm</span></span>
            <Bar value={f.rssi} min={-120} max={-40} color={CYAN} height={6} />
          </div>
          <div className="well p-2.5 flex flex-col gap-1.5">
            <span className="label-mono text-[9px]">SNR</span>
            <span className="readout text-xl">{f1(f.snr)} <span className="label-mono text-[9px]">dB</span></span>
            <Bar value={f.snr} min={-20} max={15} color={GREEN} height={6} />
          </div>
          <div className="well p-2.5 flex flex-col gap-1.5">
            <span className="label-mono text-[9px]">Link quality</span>
            <span className="readout text-xl" style={{ color: linkColor }}>{f0(f.linkQuality)} <span className="label-mono text-[9px]">%</span></span>
            <Bar value={f.linkQuality} max={100} color={linkColor} height={6} />
          </div>
        </div>

        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          <Stat label="Packets" value={f.packetCount} small color={CYAN} />
          <Stat label="Received" value={rx} small color={GREEN} />
          <Stat label="Lost" value={f.packetsLost} small color={f.packetsLost ? YELLOW : undefined} />
          <Stat label="Loss" value={`${lossPct.toFixed(1)}%`} small />
          <Stat label="CRC errors" value={f.crcErrors} small />
          <Stat label="Last packet" value={`${ageS.toFixed(1)} s`} small color={ageS > 3 ? RED : undefined} />
        </div>

        <div className="well p-2.5">
          <KV k="Radio" v="RAK3272S LoRa P2P" />
          <KV k="Frequency" v="865.25 MHz" />
          <KV k="Telemetry rate" v={f1(f.updateRate)} unit="Hz" />
          <KV k="Slant range to CanSat" v={f0(f.slantFromGs)} unit="m" />
          <KV k="Packet format" v="16-field ASCII CSV · CR" />
        </div>

        <SeriesChart
          title="RSSI and SNR"
          data={f.history}
          legend={false}
          height={140}
          lines={[
            { key: "rssi", label: "RSSI dBm", color: CYAN },
            { key: "snr", label: "SNR dB", color: GREEN, axis: "right" },
          ]}
        />
      </div>
    </div>
  );
}
