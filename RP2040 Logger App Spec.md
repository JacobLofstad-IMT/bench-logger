# RP2040 Heater Bench Logger — Spec

**Status:** design agreed, no code written yet
**Build ID convention:** `BUILD = "YYYY-MM-DDx"` (e.g. `2026-07-16a`), stamped into CSV header

---

## 1. Purpose

Browser-based data logger for a bench experiment rig. An RP2040 (MicroPython) with a
resistive heater, NTC thermistor, and pressure sensor streams sensor data over USB
serial. A button on the device starts a heat-to-setpoint cycle. This tool captures each
run to a CSV on the PC and shows live charts while it runs.

**Primary user is not the author.** The tool will be handed to a colleague who runs the
experiments. Optimize for: nothing to install, hard to get into a broken state, obvious
whether it is recording.

---

## 2. Scope

### In scope
- Connect to RP2040 over Web Serial
- Per-run metadata entry (experiment number, free-text notes)
- Parse streamed sensor lines, write incrementally to a CSV file on disk
- Live charts: temperature, pressure, duty cycle
- Capture non-data console output from the device into the same run record

### Out of scope
- **Any PC → device communication.** Read-only tap. Setpoint changes are made by editing
  the MicroPython source and re-uploading. No command protocol, no setpoint field.
- Analysis, plotting of past runs, run comparison. CSVs go to pandas/Excel afterward.
- PWA / offline support — deferred, revisit later (see §9)
- Auth, cloud upload, multi-user. All data stays local to the browser/machine.

---

## 3. Deployment

- Static site on **GitHub Pages** (`https://<user>.github.io/<repo>/`)
- Single-page app. Vanilla JS, no build step, no framework, no bundler.
- **Dependencies vendored into the repo**, not pulled from CDN — must work on a bench
  machine behind a corporate proxy.
- Repo is public. **Keep the app generic:** no client name, no project name, no protocol
  details baked into the UI or source. Identifying info is typed into the notes field by
  the operator at runtime and lives only in the local CSV.

### Hard prerequisite (verify before building)
Chrome or Edge, not locked down by IT policy. Web Serial can be disabled by admin
policy — check `chrome://policy` on the operator's actual machine. If Web Serial is
blocked, this entire approach is dead and the fallback is a Tkinter + PyInstaller app.

---

## 4. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Serial | Web Serial API | `navigator.serial`, secure-context OK on Pages |
| File write | File System Access API | `showDirectoryPicker()`, incremental writes |
| Handle persistence | IndexedDB | Store directory handle across sessions |
| Charts | **uPlot** (~40 KB) | Vendored. Streaming-oriented, `uPlot.sync()` for linked cursors |
| UI | Vanilla JS + plain CSS | No React, no bundler |

Chart.js rejected: heavier, animation layer fights streaming data.

---

## 5. Serial data format — **PLACEHOLDER**

> To be aligned with firmware. Firmware side should be changed to emit a fixed,
> machine-parseable format rather than human-readable prose. Regex-scraping prose is the
> thing that breaks silently.

**Working assumption** (subject to change):

```
D,<ticks_ms>,<temp_c>,<duty_pct>,<pressure_kpa>
```

Requirements the format must satisfy:
- Fixed field order, one sample per line, `\n` terminated
- **Device-side timestamp** (`time.ticks_ms()`) included in every sample line. Non-negotiable —
  this is the real sample spacing. PC arrival time is jittered tens of ms by USB buffering.
- A distinct prefix distinguishing **data lines** from **human/console lines** (e.g. `D,`
  for data vs `#` for messages), so the parser can route without choking on startup
  banners, tracebacks, or `print()` debugging.

Parser must be tolerant: an unparseable line is logged as a console line, never a crash.

Baud rate: TBD (USB CDC, so nominally irrelevant, but pick one and pin it).

---

## 6. CSV output

### Filename
`EXP{num:03d}_{YYYYMMDD-HHMMSS}.csv`

Never overwrite. If the target exists, append `_b`, `_c`, … rather than clobbering.

### Structure
Commented `#` metadata header, then column header row, then data rows.
Parses with `pandas.read_csv(path, comment='#')`. Chosen over a JSON sidecar (files get
separated when emailed) and over repeating metadata per-row (ugly).

```
# experiment: 007
# started_utc: 2026-07-16T14:32:01Z
# started_local: 2026-07-16 09:32:01 -0500
# build: 2026-07-16a
# notes: <free text, newlines escaped or each line re-prefixed with #>
# ---
pc_time_iso,dev_ticks_ms,temp_c,duty_pct,pressure_kpa
...
```

### Console lines
Device output that isn't a data line still belongs in the run record. Options — **pick
one at implementation time:**
- **(preferred)** interleave as `# CONSOLE <pc_time> <text>` comment lines in the CSV body
- separate `EXP007_..._console.txt` sidecar

Preference is interleaving — single file, self-describing, and preserves ordering
relative to the data.

### Write discipline
- Open file at run start, write each row as it arrives, **flush**.
- Do not accumulate in an array and dump at the end. The run that matters is the one
  where the tab gets closed early or the USB gets bumped.
- `beforeunload` guard while a run is active.

---

## 7. UI

Single screen, roughly top to bottom:

1. **Connect** button → port picker. On load, try `navigator.serial.getPorts()` and
   auto-reconnect to a previously authorized port. Show connection state plainly.
2. **Output folder** — picked once, handle persisted in IndexedDB. Subsequent sessions
   re-acquire permission with one click, not a full navigate-the-dialog.
3. **Experiment number** (int) and **Notes** (multiline free text).
4. **Start / Stop run** — big, unambiguous. Recording state must be visible at a glance.
5. **Live status:** sample count ("247 samples logged"), elapsed time, current temp /
   duty / pressure, target filename.
6. **Charts** — three stacked (§8).
7. **Console tail** — last ~10 raw lines, scrolling.

Status readout and console tail are load-bearing, not polish: they kill the entire "was
it even recording?" class of problem for ~15 min of work.

### Behavior
- Serial reads must never block chart rendering or UI.
- Start requires: port connected, folder chosen, experiment number filled. Disable the
  button and say which one is missing rather than failing on click.
- Stopping closes and flushes the file cleanly.

---

## 8. Charts

- **Three stacked charts**, not one chart with three y-axes. Temp / pressure / duty share
  no units. Stacked + `uPlot.sync()` linked cursor is clearer and less code.
- **Duty cycle rendered as a step or filled area**, not a smooth line — it's a discrete-ish
  control output and should read as one.
- **Decouple render rate from data rate.** Samples land in an array on arrival; redraw on
  a ~200 ms interval. Per-sample redraw is the mistake that makes it feel broken.
- **Ring buffer for the plot** (last N samples / sliding ~60 s window) with a
  "full run" toggle. Every sample still goes to disk regardless of what's plotted.
- X axis uses device ticks, not PC arrival time.

---

## 9. Deferred

- **PWA** (service worker + manifest). Would give offline launch and a desktop icon while
  staying on the `github.io` origin, so file handles and port permissions keep working.
  Revisit if bench network reliability turns out to be a problem.
  - Note: a plain `file://` copy of the HTML is **not** an equivalent fallback — it's a
    different, opaque origin, which loses File System Access, persisted handles, and
    remembered ports. Don't ship that as "the offline version."
- Auto-download of partial chunks, localhost-served fallback — both rejected, kept here
  only so they don't get re-proposed.

---

## 10. Open questions

1. Final serial line format + baud — blocked on firmware side.
2. Sample rate the firmware emits at? Drives ring-buffer sizing and redraw budget.
3. Console lines: interleaved comments vs sidecar (§6) — leaning interleaved.
4. Does the operator's Chrome allow Web Serial? **Check before building anything.**
5. Anything else to stamp in the header — device serial no., firmware version? Cheap to
   add now if the firmware can print it at boot, painful to add retroactively to old runs.
