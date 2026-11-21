/**
 * Mask credentials before they reach an append-only log.
 *
 * Real run logs carried `*_PASSWORD=`, `*_TOKEN=` and `mysql -p<pw>` verbatim,
 * because the measured command line is recorded as typed. Logs are append-only
 * and may be published, so the only safe place to scrub is at write time.
 * Deliberately conservative: it masks the value, keeps the name, and leaves
 * anything that does not look like an assignment alone.
 */

const MASK = "***";

const ASSIGNMENT =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|PASS|PWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/gi;
const BARE_ASSIGNMENT = /\b(PASSWORD|SECRET|TOKEN|API_?KEY)=("[^"]*"|'[^']*'|[^\s;&|]+)/gi;
const MYSQL_PASSWORD = /(\bmysql(?:dump)?\b[^\n]*?\s)-p(?!\s)(\S+)/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi;
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/g;
const KNOWN_TOKENS = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g;

export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(ASSIGNMENT, (_m, name: string) => `${name}=${MASK}`)
    .replace(BARE_ASSIGNMENT, (_m, name: string) => `${name}=${MASK}`)
    .replace(MYSQL_PASSWORD, (_m, prefix: string) => `${prefix}-p${MASK}`)
    .replace(URL_CREDENTIALS, (_m, prefix: string, _pw: string, at: string) => `${prefix}${MASK}${at}`)
    .replace(BEARER, (_m, prefix: string) => `${prefix}${MASK}`)
    .replace(KNOWN_TOKENS, MASK);
}

/** Deep-redact every string field of a JSON-ish value (events, records). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
