/**
 * Local-time date helpers.
 *
 * The dashboard is local-first and single-user: the server and the browser
 * run on the same machine, so "local time" is unambiguous. These helpers
 * exist because `Date#toISOString()` / parsing date-only strings work in
 * UTC, which shifts days/times for anyone west or east of UTC.
 */

/** YYYY-MM-DD for the given moment in the machine's local timezone. */
export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Start/end of the given LOCAL day (YYYY-MM-DD), as UTC ISO instants. */
export function localDayBounds(date: string): { dayStart: string; dayEnd: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return {
    dayStart: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
    dayEnd: new Date(y, m - 1, d, 23, 59, 59, 999).toISOString(),
  };
}

/**
 * A todo is overdue only once the END of its due day (local) has passed.
 * Date-only strings (`YYYY-MM-DD`) must not be fed to `new Date(str)` —
 * that parses as UTC midnight, marking a todo due *today* overdue all day
 * west of UTC. Full datetime strings keep their explicit instant.
 */
export function isOverdue(due: string, now: Date = new Date()): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (m) {
    const endOfDueDay = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      23,
      59,
      59,
      999
    );
    return endOfDueDay < now;
  }
  return new Date(due) < now;
}
