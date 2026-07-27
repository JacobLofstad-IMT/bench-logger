# RP2040 Heater Bench Logger

Browser-based data logger for the bench rig. See [`RP2040 Logger App Spec.md`](RP2040%20Logger%20App%20Spec.md)
for the full design. This file just covers running it locally and deploying it.

No build step — plain ES modules, vendored dependencies. Editing a `.js` file and
reloading the page is the whole dev loop.

## Local dev

Needs to be served over HTTP (module scripts and Web Serial / File System Access don't
work from a `file://` URL). Any static file server works, e.g.:

```
python -m http.server 8420
```

then open `http://localhost:8420`. Chrome or Edge required (Web Serial).

## Deploying to GitHub Pages

1. Bump `APP_BUILD` in [`js/config.js`](js/config.js) — `YYYY-MM-DDx` convention, stamped
   into every CSV header. This is manual; nothing auto-generates it.
2. Commit and push to the branch GitHub Pages serves from (or push to `main` and enable
   Pages in repo settings → Pages → deploy from branch, root).
3. Site is live at `https://<user>.github.io/<repo>/`.

That's it — no build/CI step, the repo *is* the deployed site.

## Before handing this to the bench operator

- Confirm Web Serial isn't blocked by IT policy on their machine: `chrome://policy`.
  If it's blocked, this whole approach is dead (spec §3) — fall back is a
  Tkinter/PyInstaller app.
- Walk them through Connect → choose folder → experiment number → Start once, so they've
  seen what "recording" looks like (status readout + console tail are there specifically
  so "is it working?" is never a guessing game).
- **Pick an output folder that is NOT synced by Dropbox/OneDrive/Google Drive and not
  live-scanned** (e.g. `C:\BenchLogs`), then copy runs into the shared drive afterward.
  A sync client touches the file mid-run, which clashes with the live file writes and
  shows up as a `state had changed since it was read from disk` error in the console
  tail. The app now retries around these, but logging to a quiet local folder avoids the
  fight entirely.
- Tell them **not to open the CSV in Excel while a run is recording** — Excel locks the
  file on Windows and blocks writes until it's closed. Open it after Stop, or copy first.

## Updating vendored dependencies

`vendor/uplot/` is committed, not installed — the repo must work on a bench machine
behind a corporate proxy with no npm access. To update uPlot, download a new release's
`dist/uPlot.iife.min.js` and `dist/uPlot.min.css` and overwrite the files in place.
