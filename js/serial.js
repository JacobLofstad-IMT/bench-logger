import { BAUD_RATE } from "./config.js";

// Wraps a single Web Serial port: connect/auto-reconnect, a line-buffered read loop
// that never blocks the caller, and disconnect/cleanup.
//
// Usage:
//   const conn = new SerialConnection({ onLine, onStatusChange });
//   await conn.tryAutoReconnect();      // on page load
//   await conn.requestAndConnect();     // on Connect button click
//   await conn.disconnect();
export class SerialConnection {
  constructor({ onLine, onStatusChange }) {
    this.onLine = onLine;
    this.onStatusChange = onStatusChange;
    this.port = null;
    this.reader = null;
    this.readableClosed = null;
    this.connected = false;
    this.lineBuffer = "";
  }

  static isSupported() {
    return "serial" in navigator;
  }

  async tryAutoReconnect() {
    if (!SerialConnection.isSupported()) return false;
    const ports = await navigator.serial.getPorts();
    if (ports.length === 0) return false;
    // Spec doesn't cover multiple previously-authorized ports; take the first.
    try {
      await this._openAndRead(ports[0]);
      return true;
    } catch (err) {
      this._setStatus("error", `Auto-reconnect failed: ${err.message}`);
      return false;
    }
  }

  async requestAndConnect() {
    if (!SerialConnection.isSupported()) {
      this._setStatus("unsupported", "Web Serial not available in this browser.");
      return;
    }
    const port = await navigator.serial.requestPort();
    await this._openAndRead(port);
  }

  async disconnect() {
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch (_) {
        // Reader already errored/closed — fine, we're tearing down anyway.
      }
    }
    if (this.readableClosed) {
      try {
        await this.readableClosed;
      } catch (_) {
        // Expected when cancel() aborts the pipe.
      }
    }
    if (this.port) {
      try {
        await this.port.close();
      } catch (_) {
        // Port may already be closed (e.g. device unplugged).
      }
    }
    this.reader = null;
    this.readableClosed = null;
    this.port = null;
    this.connected = false;
    this.lineBuffer = "";
    this._setStatus("disconnected");
  }

  async _openAndRead(port) {
    this.port = port;
    await port.open({ baudRate: BAUD_RATE });
    this.connected = true;
    this._setStatus("connected");

    // Run the read loop in the background — never awaited by callers, so it can
    // never block UI or chart rendering.
    this._readLoop();
  }

  async _readLoop() {
    const textStream = this.port.readable.pipeThrough(new TextDecoderStream());
    this.reader = textStream.getReader();
    this.readableClosed = (async () => {
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this._feed(value);
        }
      } catch (err) {
        // Typically a device unplug mid-read.
        this._setStatus("error", `Serial read error: ${err.message}`);
      } finally {
        this.connected = false;
        if (this.reader) {
          try {
            this.reader.releaseLock();
          } catch (_) {
            // ignore
          }
        }
      }
    })();
  }

  _feed(chunk) {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    // Last element is either "" (buffer ended exactly on a newline) or a partial
    // line to carry over to the next chunk.
    this.lineBuffer = lines.pop();
    for (const line of lines) {
      this.onLine(line);
    }
  }

  _setStatus(state, detail) {
    if (this.onStatusChange) this.onStatusChange(state, detail);
  }
}
