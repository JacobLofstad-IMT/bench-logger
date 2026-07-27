import { CSV_COMMIT_MS } from "./config.js";

// ---- Pure formatting helpers (no DOM / File System Access — testable under plain Node) ----

export function pad(n, width) {
  return String(n).padStart(width, "0");
}

export function formatFilenameBase(expNum, date) {
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1, 2);
  const d = pad(date.getDate(), 2);
  const h = pad(date.getHours(), 2);
  const mi = pad(date.getMinutes(), 2);
  const s = pad(date.getSeconds(), 2);
  return `EXP${pad(expNum, 3)}_${y}${mo}${d}-${h}${mi}${s}`;
}

// index 0 = no suffix (the original name). index 1.. = "_b", "_c", ... "_z", then
// "_dup27", "_dup28", ... (collisions past 26 in the same second are not expected
// in practice; this just guarantees we never clobber a file rather than being pretty).
export function suffixForIndex(index) {
  if (index === 0) return "";
  if (index >= 1 && index <= 25) return "_" + String.fromCharCode(97 + index); // _b.._z
  return `_dup${index + 1}`;
}

export function formatUtcTimestamp(date) {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

export function formatLocalTimestamp(date) {
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1, 2);
  const d = pad(date.getDate(), 2);
  const h = pad(date.getHours(), 2);
  const mi = pad(date.getMinutes(), 2);
  const s = pad(date.getSeconds(), 2);
  const offsetMin = -date.getTimezoneOffset(); // JS gives minutes *behind* UTC; flip sign
  const sign = offsetMin >= 0 ? "+" : "-";
  const offH = pad(Math.floor(Math.abs(offsetMin) / 60), 2);
  const offM = pad(Math.abs(offsetMin) % 60, 2);
  return `${y}-${mo}-${d} ${h}:${mi}:${s} ${sign}${offH}${offM}`;
}

function commentPrefixNotes(notes) {
  const lines = (notes ?? "").split("\n");
  return lines
    .map((line, i) => (i === 0 ? `# notes: ${line}` : `# ${line}`))
    .join("\n");
}

// Run-constant config the firmware broadcasts on every data line. Recorded once here
// rather than per-row since it never changes during a run. "unknown" if no data line
// was seen before the run started.
function formatConfigValue(v) {
  return v == null || !Number.isFinite(v) ? "unknown" : String(v);
}

export function formatHeaderBlock({ expNum, startDate, build, notes, config }) {
  const c = config || {};
  const lines = [
    `# experiment: ${pad(expNum, 3)}`,
    `# started_utc: ${formatUtcTimestamp(startDate)}`,
    `# started_local: ${formatLocalTimestamp(startDate)}`,
    `# build: ${build}`,
    `# temp_setpoint_c: ${formatConfigValue(c.tempSetpointC)}`,
    `# max_duty_pct: ${formatConfigValue(c.maxDutyPct)}`,
    `# pressure_inflated_kpa: ${formatConfigValue(c.pressureInflatedKpa)}`,
    commentPrefixNotes(notes),
    `# ---`,
    `pc_time_iso,dev_ticks_ms,temp_c,duty_pct,pressure_kpa`,
  ];
  return lines.join("\n") + "\n";
}

export function formatDataRow({ pcTimeIso, ticksMs, tempC, dutyPct, pressureKpa }) {
  return `${pcTimeIso},${ticksMs},${tempC},${dutyPct},${pressureKpa}\n`;
}

export function formatConsoleLine({ pcTimeIso, text }) {
  return `# CONSOLE ${pcTimeIso} ${text}\n`;
}

// ---- Filesystem-touching parts (browser only: needs a real FileSystemDirectoryHandle) ----

// Finds an available filename under dirHandle and creates it, never overwriting an
// existing file (spec §6 "never overwrite").
export async function createRunFileHandle(dirHandle, expNum, startDate) {
  const base = formatFilenameBase(expNum, startDate);
  for (let index = 0; ; index++) {
    const name = `${base}${suffixForIndex(index)}.csv`;
    const exists = await fileExists(dirHandle, name);
    if (!exists) {
      return dirHandle.getFileHandle(name, { create: true });
    }
  }
}

async function fileExists(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name, { create: false });
    return true;
  } catch (err) {
    if (err.name === "NotFoundError") return false;
    throw err;
  }
}

const _enc = new TextEncoder();
function byteLength(str) {
  return _enc.encode(str).length;
}

// Represents one open run's CSV file.
//
// Design (revised): the writable is kept OPEN and appended to across many rows, and
// only closed+reopened on a timer (every CSV_COMMIT_MS) to commit to disk. This is a
// deliberate change from close/reopen-per-row, which failed in practice: the File
// System Access API re-reads the file's on-disk state on every createWritable()/close()
// and throws "state had changed since it was read from disk" when an external process
// (Dropbox sync, antivirus, Windows indexer, or Excel) touches the file in between —
// which happens constantly when logging into a synced folder. Reopening infrequently
// shrinks that window enormously; the resilient write chain retries the rest.
//
// Durability tradeoff: an unclean tab kill loses at most the rows since the last
// commit (~CSV_COMMIT_MS), not the whole run. Every row is still flushed on stop().
//
// We track the byte offset ourselves (UTF-8, via TextEncoder) rather than calling
// getFile().size — that getFile() read was itself a source of the staleness error, and
// tracking is exact because we are the only writer.
export class CsvRun {
  static async start(dirHandle, { expNum, notes, build, config, startDate = new Date() }) {
    const fileHandle = await createRunFileHandle(dirHandle, expNum, startDate);
    const run = new CsvRun(fileHandle, startDate, expNum);
    run._pending.push(formatHeaderBlock({ expNum, startDate, build, notes, config }));
    await run._run(() => run._drain());
    await run.commit(); // make the header durable immediately
    run._timer = setInterval(() => {
      run.commit().catch(() => {}); // errors surface via the next write's rejection
    }, CSV_COMMIT_MS);
    return run;
  }

  constructor(fileHandle, startDate, expNum) {
    this.fileHandle = fileHandle;
    this.startDate = startDate;
    this.expNum = expNum;
    this.rowCount = 0;
    this._pending = []; // text not yet written into the open writable
    this._writable = null; // currently-open stream, or null between commits
    this._offset = 0; // bytes written so far (== true file size)
    this._closed = false; // run stopped; do not reopen
    this._timer = null;
    this._chain = Promise.resolve();
  }

  get filename() {
    return this.fileHandle.name;
  }

  async writeDataRow(row) {
    this._pending.push(formatDataRow(row));
    this.rowCount++;
    await this._run(() => this._drain());
  }

  async writeConsoleLine(entry) {
    this._pending.push(formatConsoleLine(entry));
    await this._run(() => this._drain());
  }

  // Close (commit to disk) and reopen lazily on the next write. Called on a timer.
  async commit() {
    await this._run(async () => {
      await this._drain();
      if (this._writable) {
        await this._writable.close();
        this._writable = null;
      }
    });
  }

  // Final flush + close. No reopen. Call on stop().
  async close() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    await this._run(async () => {
      await this._drain();
      if (this._writable) {
        await this._writable.close();
        this._writable = null;
      }
      this._closed = true;
    });
  }

  // Serializes all file operations. The stored chain is kept always-resolved (`.catch`)
  // so one failed op — e.g. a transient staleness/lock error — does NOT poison the
  // chain and silently drop everything after it. The returned promise still rejects so
  // the caller (main.js) can surface the error in the console tail.
  _run(task) {
    const run = this._chain.then(task, task);
    this._chain = run.catch(() => {});
    return run;
  }

  async _ensureOpen() {
    if (this._writable || this._closed) return;
    this._writable = await this.fileHandle.createWritable({ keepExistingData: true });
    if (this._offset > 0) await this._writable.seek(this._offset);
  }

  // Writes buffered text into the open writable. Must run inside _run().
  async _drain() {
    if (this._pending.length === 0 || this._closed) return;
    await this._ensureOpen(); // may throw → _pending retained, retried next time
    // Snapshot before the await so rows arriving mid-write aren't lost when we clear.
    const batch = this._pending;
    this._pending = [];
    const text = batch.join("");
    try {
      await this._writable.write(text);
      this._offset += byteLength(text);
    } catch (err) {
      this._pending = batch.concat(this._pending); // retry these rows next flush
      throw err;
    }
  }
}
