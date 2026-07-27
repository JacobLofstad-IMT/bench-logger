// Parses one raw serial line into a data record or a console record.
// Never throws — an unparseable line is routed to console, per spec §5.
//
// Data format:
//   D,<ticks_ms>,<temp_c>,<duty_pct>,<pressure_kpa>,<temp_raw>,<temp_setpoint_c>,<max_duty_pct>,<pressure_inflated_kpa>
// temp_raw (index 5) is firmware calibration/debug output and is intentionally ignored.
// temp_setpoint_c / max_duty_pct / pressure_inflated_kpa are run-constant config the
// firmware re-broadcasts every line (so ordering of MCU vs logger startup doesn't matter);
// they're captured for the CSV header, not logged per-row.
// Everything else (banners, tracebacks, print() debugging, blank lines) is console text.
//
// Returns:
//   { type: 'data', ticksMs, tempC, dutyPct, pressureKpa,
//     tempSetpointC, maxDutyPct, pressureInflatedKpa }
//   { type: 'console', text }
//   null for an empty/whitespace-only line (nothing to record)
export function parseLine(rawLine) {
  const line = stripTrailingCr(rawLine);
  const trimmed = line.trim();

  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("D,")) {
    const data = tryParseDataLine(trimmed);
    if (data) return data;
    // Looked like a data line but didn't parse cleanly — surface it as console text
    // rather than silently dropping it, so the operator can still see it happened.
  }

  return { type: "console", text: line };
}

function tryParseDataLine(trimmed) {
  const fields = trimmed.split(",");
  if (fields.length !== 9) return null;

  // fields[0] = "D", fields[5] = temp_raw (ignored).
  const ticksMs = Number(fields[1]);
  const tempC = Number(fields[2]);
  const dutyPct = Number(fields[3]);
  const pressureKpa = Number(fields[4]);
  const tempSetpointC = Number(fields[6]);
  const maxDutyPct = Number(fields[7]);
  const pressureInflatedKpa = Number(fields[8]);

  // temp_raw is not validated — it's debug-only and we never read its value.
  const numbers = [
    ticksMs,
    tempC,
    dutyPct,
    pressureKpa,
    tempSetpointC,
    maxDutyPct,
    pressureInflatedKpa,
  ];
  if (!numbers.every(Number.isFinite)) return null;

  return {
    type: "data",
    ticksMs,
    tempC,
    dutyPct,
    pressureKpa,
    tempSetpointC,
    maxDutyPct,
    pressureInflatedKpa,
  };
}

function stripTrailingCr(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
