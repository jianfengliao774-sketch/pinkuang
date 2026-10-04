/** Event block timestamps are seconds. Missing timestamps stay unknown. */
export function activityTimeUtc8(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  const instant = new Date(timestamp * 1000);
  const local = new Date(timestamp * 1000 + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(instant.getTime()) || !Number.isFinite(local.getTime())) return null;
  const pad = value => String(value).padStart(2, '0');
  return {
    iso: instant.toISOString(),
    label: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`,
  };
}
