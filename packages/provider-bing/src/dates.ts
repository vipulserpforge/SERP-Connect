/**
 * Bing's JSON dates look like `/Date(1316156400000-0700)/`: milliseconds since the Unix epoch plus a UTC offset (hhmm).
 * Microsoft's own example (1316156400000-0700) is 2011-09-16 07:00 UTC = 2011-09-16 00:00 at -07:00, so the calendar date the
 * value stands for is the epoch time shifted by the offset. Returns YYYY-MM-DD, or null when the value is not in that format.
 */
export function parseBingDate(value: string): string | null {
  const m = /^\/Date\((-?\d{1,15})(?:([+-])(\d{2})(\d{2}))?\)\/$/.exec(value.trim());
  if (!m) return null;
  const ms = Number(m[1]);
  const offsetMs = m[2] ? (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])) * 60_000 : 0;
  const t = new Date(ms + offsetMs);
  if (Number.isNaN(t.getTime())) return null;
  const iso = t.toISOString();
  const year = Number(iso.slice(0, 4));
  return year >= 2000 && year <= 2100 ? iso.slice(0, 10) : null;
}
