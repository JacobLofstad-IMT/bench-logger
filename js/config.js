// Hand-bumped on each deploy — no build step to stamp this automatically.
// Convention: YYYY-MM-DDx (x = a, b, c... for multiple deploys same day).
export const APP_BUILD = "2026-07-27a";

// USB CDC, so the number is nominally irrelevant, but pin one so both ends agree.
export const BAUD_RATE = 115200;

// Default charts time window, in seconds — how much recent history is shown before
// old samples scroll off the left. Operator can change this live, or switch to "full
// run". Windowing is by device time, not sample count, so it's rate-independent.
export const DEFAULT_WINDOW_SECONDS = 60;

// Chart redraw cadence — decoupled from data arrival rate.
export const REDRAW_MS = 200;

// Console tail length shown in the UI.
export const CONSOLE_TAIL_LINES = 10;

// How often (ms) the CSV writable is closed+reopened to commit buffered rows to disk.
// The file is kept open and appended between commits, so a tab kill loses at most this
// much data. Lower = more durable but reopens the file more often (each reopen re-reads
// on-disk state and can clash with a folder that's being synced/scanned). 1.5s balances
// durability against that friction; every row is still flushed on stop().
export const CSV_COMMIT_MS = 1500;
