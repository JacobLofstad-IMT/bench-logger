import { DEFAULT_WINDOW_SECONDS, REDRAW_MS } from "./config.js";

// uPlot is loaded as a plain (non-module) IIFE script in index.html, so it's a global.
const uPlotLib = window.uPlot;

const SYNC_KEY = "logger-sync";

const SECONDS_AXIS = {
  values: (_u, vals) => vals.map((v) => (v / 1000).toFixed(1) + "s"),
};

// Manages the 3 stacked charts (temp / pressure / duty), a shared cursor, an
// in-memory sample history for the run, and a decoupled redraw loop.
//
// Every sample is written to disk regardless of what's plotted (spec §8) — this class
// only owns what's on screen. It keeps the *entire* run's samples in memory and, by
// default, plots only the trailing time window (device-time based, so it's independent
// of sample rate) so uPlot isn't redrawing huge series while a run is actively
// streaming. The operator can widen/narrow the window live or switch to full run.
export class ChartGroup {
  constructor({ tempEl, pressureEl, dutyEl }) {
    this.samples = [];
    this.windowMs = DEFAULT_WINDOW_SECONDS * 1000; // null = show full run
    this._dirty = false;

    this.tempChart = new uPlotLib(
      this._opts("Temperature (°C)", [
        { label: "temp_c", stroke: "#e4572e", width: 2 },
      ]),
      [[], []],
      tempEl
    );
    this.pressureChart = new uPlotLib(
      this._opts("Pressure (kPa)", [
        { label: "pressure_kpa", stroke: "#2e86e4", width: 2 },
      ]),
      [[], []],
      pressureEl
    );
    this.dutyChart = new uPlotLib(
      this._opts("Duty (%)", [
        {
          label: "duty_pct",
          stroke: "#3ba05c",
          width: 2,
          fill: "rgba(59,160,92,0.15)",
          paths: uPlotLib.paths.stepped({ align: 1 }),
        },
      ]),
      [[], []],
      dutyEl
    );

    this._charts = [this.tempChart, this.pressureChart, this.dutyChart];
    this._onResize = () => this._resizeToContainers();
    window.addEventListener("resize", this._onResize);
    this._resizeToContainers();

    this._timer = setInterval(() => this._redrawIfDirty(), REDRAW_MS);
  }

  _opts(title, series) {
    return {
      title,
      width: 600,
      height: 180,
      cursor: { sync: { key: SYNC_KEY } },
      // x is device ticks_ms, NOT a wall-clock timestamp. Without time:false uPlot
      // treats x as Unix epoch seconds and its range/tick math misbehaves — the
      // symptom being new points appearing at the right edge while the historical
      // line fails to render until a lucky reload.
      scales: { x: { time: false } },
      axes: [SECONDS_AXIS, {}],
      series: [{ label: "t" }, ...series],
    };
  }

  _resizeToContainers() {
    for (const chart of this._charts) {
      const width = chart.root.parentElement?.clientWidth || 600;
      chart.setSize({ width, height: 180 });
    }
  }

  // Clears history for a new run.
  reset() {
    this.samples = [];
    this._dirty = true;
    this._redrawIfDirty();
  }

  pushSample(sample) {
    this.samples.push(sample);
    this._dirty = true;
  }

  // windowSeconds: a positive number for a trailing window, or null for full run.
  setWindowSeconds(windowSeconds) {
    this.windowMs =
      windowSeconds == null || !(windowSeconds > 0) ? null : windowSeconds * 1000;
    this._dirty = true;
  }

  _redrawIfDirty() {
    if (!this._dirty) return;
    this._dirty = false;

    const n = this.samples.length;

    // Find where the visible window starts. For a trailing window we only scan back
    // over the window's worth of samples, so cost is bounded regardless of run length.
    let startIdx = 0;
    if (this.windowMs != null && n) {
      const cutoff = this.samples[n - 1].ticksMs - this.windowMs;
      startIdx = n;
      while (startIdx > 0 && this.samples[startIdx - 1].ticksMs >= cutoff) startIdx--;
    }

    const len = n - startIdx;
    const xs = new Array(len);
    const temps = new Array(len);
    const pressures = new Array(len);
    const duties = new Array(len);
    for (let i = 0; i < len; i++) {
      const s = this.samples[startIdx + i];
      xs[i] = s.ticksMs;
      temps[i] = s.tempC;
      pressures[i] = s.pressureKpa;
      duties[i] = s.dutyPct;
    }

    // resetScales=true auto-ranges both axes to the visible (already window-sliced)
    // data, so x spans exactly the shown window and y fits the values in it.
    this.tempChart.setData([xs, temps], true);
    this.pressureChart.setData([xs, pressures], true);
    this.dutyChart.setData([xs, duties], true);
  }

  destroy() {
    clearInterval(this._timer);
    window.removeEventListener("resize", this._onResize);
    for (const chart of this._charts) chart.destroy();
  }
}
