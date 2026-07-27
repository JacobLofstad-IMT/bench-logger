import { APP_BUILD, CONSOLE_TAIL_LINES } from "./config.js";
import { parseLine } from "./parser.js";
import { SerialConnection } from "./serial.js";
import { getDirectoryHandle, saveDirectoryHandle, verifyPermission } from "./storage.js";
import { CsvRun } from "./csv.js";
import { ChartGroup } from "./charts.js";

const el = (id) => document.getElementById(id);

const connectBtn = el("connect-btn");
const disconnectBtn = el("disconnect-btn");
const connectionStatus = el("connection-status");
const folderBtn = el("folder-btn");
const folderReconnectBtn = el("folder-reconnect-btn");
const folderStatus = el("folder-status");
const expNumInput = el("exp-num");
const notesInput = el("notes");
const startStopBtn = el("start-stop-btn");
const startMissing = el("start-missing");
const startError = el("start-error");
const sampleCountEl = el("sample-count");
const elapsedEl = el("elapsed");
const curTempEl = el("cur-temp");
const curDutyEl = el("cur-duty");
const curPressureEl = el("cur-pressure");
const curFilenameEl = el("cur-filename");
const windowSelect = el("window-select");
const windowCustom = el("window-custom");
const consoleTailEl = el("console-tail");

const state = {
  serialConnected: false,
  folderHandle: null,
  folderReady: false,
  runActive: false,
  csvRun: null,
  sampleCount: 0,
  startTimeMs: null,
  consoleLines: [],
  // Latest run-constant config seen on the serial stream, stamped into the CSV header
  // at run start. null until the first valid data line arrives.
  latestConfig: null,
};

let elapsedTimer = null;

// Charts depend on the vendored uPlot script having loaded. If that fails for any
// reason, the rest of the app (serial connect, folder, start/stop, CSV writing) must
// keep working — a dead chart is not a reason to lose the whole tool.
let chartGroup;
try {
  chartGroup = new ChartGroup({
    tempEl: el("chart-temp"),
    pressureEl: el("chart-pressure"),
    dutyEl: el("chart-duty"),
  });
} catch (err) {
  console.error("Chart init failed — continuing without live charts:", err);
  chartGroup = { reset() {}, pushSample() {}, setWindowSeconds() {} };
  appendConsoleTail(`[charts] failed to initialize: ${err.message}`);
}

// ---- Serial ----

const serial = new SerialConnection({
  onLine: handleLine,
  onStatusChange: (status, detail) => {
    state.serialConnected = status === "connected";
    setPill(connectionStatus, statusLabel(status, detail), pillClassFor(status));
    connectBtn.disabled = state.serialConnected;
    disconnectBtn.disabled = !state.serialConnected || state.runActive;
    updateStartGating();
  },
});

function statusLabel(status, detail) {
  switch (status) {
    case "connected":
      return "Connected";
    case "disconnected":
      return "Not connected";
    case "unsupported":
      return "Web Serial not supported in this browser";
    case "error":
      return detail || "Serial error";
    default:
      return status;
  }
}

function pillClassFor(status) {
  if (status === "connected") return "status-ok";
  if (status === "error" || status === "unsupported") return "status-error";
  return "status-unknown";
}

connectBtn.addEventListener("click", async () => {
  try {
    await serial.requestAndConnect();
  } catch (err) {
    // User cancelling the port picker throws — not a real error, ignore quietly.
    if (err.name !== "NotFoundError") {
      appendConsoleTail(`[serial] ${err.message}`);
    }
  }
});

disconnectBtn.addEventListener("click", async () => {
  await serial.disconnect();
});

// ---- Folder ----

async function initFolder() {
  const handle = state.folderHandle ?? (await getDirectoryHandle());
  if (!handle) {
    setPill(folderStatus, "No folder chosen", "status-unknown");
    return;
  }
  const granted = (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  if (granted) {
    setFolder(handle);
  } else {
    state.folderHandle = handle;
    folderReconnectBtn.hidden = false;
    folderReconnectBtn.textContent = `Reconnect folder: ${handle.name}`;
    setPill(folderStatus, `Permission needed for "${handle.name}"`, "status-unknown");
  }
}

function setFolder(handle) {
  state.folderHandle = handle;
  state.folderReady = true;
  folderReconnectBtn.hidden = true;
  setPill(folderStatus, `Using "${handle.name}"`, "status-ok");
  updateStartGating();
}

folderBtn.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker();
    const granted = await verifyPermission(handle, "readwrite");
    if (!granted) {
      setPill(folderStatus, "Permission denied", "status-error");
      return;
    }
    await saveDirectoryHandle(handle);
    setFolder(handle);
  } catch (err) {
    if (err.name !== "AbortError") appendConsoleTail(`[folder] ${err.message}`);
  }
});

folderReconnectBtn.addEventListener("click", async () => {
  const granted = await verifyPermission(state.folderHandle, "readwrite");
  if (granted) {
    setFolder(state.folderHandle);
  } else {
    setPill(folderStatus, "Permission denied", "status-error");
  }
});

// ---- Run gating ----

function missingRequirements() {
  const missing = [];
  if (!state.serialConnected) missing.push("device not connected");
  if (!state.folderReady) missing.push("no output folder");
  if (!expNumInput.value.trim()) missing.push("experiment number");
  return missing;
}

function updateStartGating() {
  if (state.runActive) return; // Stop is always available while running.
  const missing = missingRequirements();
  startStopBtn.disabled = missing.length > 0;
  startMissing.textContent = missing.length ? `Missing: ${missing.join(", ")}` : "";
}

expNumInput.addEventListener("input", updateStartGating);

// ---- Start / stop ----

startStopBtn.addEventListener("click", () => {
  if (state.runActive) {
    stopRun();
  } else {
    startRun();
  }
});

async function startRun() {
  startError.hidden = true;
  const expNum = parseInt(expNumInput.value, 10);
  try {
    const csvRun = await CsvRun.start(state.folderHandle, {
      expNum,
      notes: notesInput.value,
      build: APP_BUILD,
      config: state.latestConfig,
    });
    state.csvRun = csvRun;
    state.runActive = true;
    state.sampleCount = 0;
    state.startTimeMs = Date.now();
    chartGroup.reset();

    startStopBtn.textContent = "Stop run";
    startStopBtn.classList.add("recording");
    startStopBtn.disabled = false;
    startMissing.textContent = "";
    folderBtn.disabled = true;
    folderReconnectBtn.disabled = true;
    expNumInput.disabled = true;
    disconnectBtn.disabled = true;

    curFilenameEl.textContent = csvRun.filename;
    sampleCountEl.textContent = "0";
    startElapsedTimer();
  } catch (err) {
    startError.hidden = false;
    startError.textContent = `Could not start run: ${err.message}`;
  }
}

async function stopRun() {
  startStopBtn.disabled = true;
  try {
    await state.csvRun.close();
  } finally {
    state.runActive = false;
    stopElapsedTimer();
    startStopBtn.textContent = "Start run";
    startStopBtn.classList.remove("recording");
    folderBtn.disabled = false;
    folderReconnectBtn.disabled = false;
    expNumInput.disabled = false;
    disconnectBtn.disabled = !state.serialConnected;
    updateStartGating();
  }
}

function startElapsedTimer() {
  stopElapsedTimer();
  updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function updateElapsed() {
  const totalSec = Math.floor((Date.now() - state.startTimeMs) / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  elapsedEl.textContent = `${h}:${m}:${s}`;
}

// ---- Incoming line handling ----

function handleLine(rawLine) {
  const parsed = parseLine(rawLine);
  if (!parsed) return;
  const pcTimeIso = new Date().toISOString();

  if (parsed.type === "data") {
    // Capture the run-constant config carried on every data line (for the CSV header).
    state.latestConfig = {
      tempSetpointC: parsed.tempSetpointC,
      maxDutyPct: parsed.maxDutyPct,
      pressureInflatedKpa: parsed.pressureInflatedKpa,
    };

    curTempEl.textContent = parsed.tempC.toFixed(1);
    curDutyEl.textContent = parsed.dutyPct.toFixed(1);
    curPressureEl.textContent = parsed.pressureKpa.toFixed(1);
    chartGroup.pushSample(parsed);

    if (state.runActive) {
      state.sampleCount++;
      sampleCountEl.textContent = String(state.sampleCount);
      state.csvRun
        .writeDataRow({ pcTimeIso, ...parsed })
        .catch((err) => appendConsoleTail(`[csv write error] ${err.message}`));
    }
  } else {
    appendConsoleTail(parsed.text);
    if (state.runActive) {
      state.csvRun
        .writeConsoleLine({ pcTimeIso, text: parsed.text })
        .catch((err) => appendConsoleTail(`[csv write error] ${err.message}`));
    }
  }
}

function appendConsoleTail(text) {
  state.consoleLines.push(text);
  if (state.consoleLines.length > CONSOLE_TAIL_LINES) {
    state.consoleLines.splice(0, state.consoleLines.length - CONSOLE_TAIL_LINES);
  }
  consoleTailEl.textContent = state.consoleLines.join("\n");
  consoleTailEl.scrollTop = consoleTailEl.scrollHeight;
}

// ---- Charts ----

function applyChartWindow() {
  const v = windowSelect.value;
  if (v === "full") {
    windowCustom.hidden = true;
    chartGroup.setWindowSeconds(null);
  } else if (v === "custom") {
    windowCustom.hidden = false;
    const sec = parseFloat(windowCustom.value);
    if (sec > 0) chartGroup.setWindowSeconds(sec);
  } else {
    windowCustom.hidden = true;
    chartGroup.setWindowSeconds(parseFloat(v));
  }
}

windowSelect.addEventListener("change", applyChartWindow);
windowCustom.addEventListener("input", () => {
  if (windowSelect.value !== "custom") return;
  const sec = parseFloat(windowCustom.value);
  if (sec > 0) chartGroup.setWindowSeconds(sec);
});

// ---- Misc ----

function setPill(elm, text, cls) {
  elm.textContent = text;
  elm.className = `status-pill ${cls}`;
}

window.addEventListener("beforeunload", (e) => {
  if (!state.runActive) return;
  e.preventDefault();
  e.returnValue = "";
});

// Dev-only hook: pushes a synthetic serial line through the same code path real
// hardware data takes. Not wired to any UI control.
window.__debugFeedLine = handleLine;

// ---- Init ----

// Show the loaded build so it's obvious whether a redeploy actually took effect
// (this app has no build step, so browsers can serve stale cached modules).
el("app-build").textContent = `build ${APP_BUILD}`;

if (!SerialConnection.isSupported()) {
  setPill(connectionStatus, "Web Serial not supported in this browser", "status-error");
  connectBtn.disabled = true;
}

initFolder();
serial.tryAutoReconnect().then(updateStartGating);
updateStartGating();
