/**
 * Thin wrapper over the browser Web Serial API (Chrome / Edge, on localhost or
 * https). The ground LoRa receiver (RAK3272S on USB) appears as a serial port.
 * Types are declared here because TypeScript's DOM lib does not include them.
 */

type SerialPortLike = {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
};
type SerialLike = { requestPort(): Promise<SerialPortLike>; getPorts(): Promise<SerialPortLike[]> };

export const serialSupported = (): boolean => typeof navigator !== "undefined" && "serial" in navigator;

export type OpenSerial = {
  label: string;
  write(text: string): Promise<void>;
  close(): Promise<void>;
};

export async function openSerial(
  baudRate: number,
  onText: (text: string) => void,
  onClosed: (error?: string) => void,
): Promise<OpenSerial> {
  const serial = (navigator as unknown as { serial: SerialLike }).serial;
  // one port already authorised for this site: use it without the picker; otherwise show the picker
  const granted = await serial.getPorts().catch(() => [] as SerialPortLike[]);
  const port = granted.length === 1 ? granted[0] : await serial.requestPort();
  await port.open({ baudRate });
  if (!port.readable || !port.writable) throw new Error("port opened without streams");

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  let closing = false;

  const loop = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) onText(decoder.decode(value, { stream: true }));
      }
      if (!closing) onClosed("port closed");
    } catch (e) {
      if (!closing) onClosed(e instanceof Error ? e.message : String(e));
    }
  })();

  const info = port.getInfo?.() ?? {};
  const label = info.usbVendorId
    ? `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")} @ ${baudRate}`
    : `serial port @ ${baudRate}`;

  return {
    label,
    write: (text) => writer.write(encoder.encode(text)),
    close: async () => {
      closing = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      await loop.catch(() => undefined);
      try {
        reader.releaseLock();
        writer.releaseLock();
      } catch {
        /* ignore */
      }
      await port.close().catch(() => undefined);
    },
  };
}
