export function parseSlashDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!match) throw new Error(`Invalid slash date: ${value}`);
  const [, monthText, dayText, yearText] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return date.toISOString().slice(0, 10);
}

/** A conservative public-availability instant: 23:59:59 in New York on the filing date. */
export function endOfDayNewYork(isoDay: string): Date {
  const noon = new Date(`${isoDay}T12:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  });
  const offset = formatter.formatToParts(noon).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset ?? "");
  if (!match) throw new Error(`Cannot determine New York offset for ${isoDay}`);
  const sign = match[1] === "+" ? 1 : -1;
  const minutes = sign * (Number(match[2]) * 60 + Number(match[3]));
  return new Date(Date.UTC(noon.getUTCFullYear(), noon.getUTCMonth(), noon.getUTCDate(), 23, 59, 59, 999) - minutes * 60_000);
}
