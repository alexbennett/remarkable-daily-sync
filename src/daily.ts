const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function dailyDate(file: string, root: string): string | null {
  const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  if (!file.startsWith(prefix)) return null;
  const relative = file.slice(prefix.length);
  const match = relative.match(/^\((\d{1,2})\) ([A-Za-z]+) (\d{4})\/([A-Za-z]+) (\d{1,2}), (\d{4})\.md$/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[4]) + 1;
  const day = Number(match[5]); const year = Number(match[6]);
  // The core Daily Notes plugin may still point at last month's folder. Use the
  // filename's date rather than silently excluding a freshly created daily note.
  if (month < 1 || Number(match[1]) !== MONTHS.indexOf(match[2]) + 1) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
