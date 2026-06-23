// Date/time utilities for RIWS
// IMPORTANT: All timestamps stored as ISO 8601 strings in UTC.
// Display format: YYYY-MM-DD HH:mm:ss (24-hour) in local time.

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatDisplay(isoString: string): string {
  const d = new Date(isoString);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function todayDateString(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function offsetMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}
