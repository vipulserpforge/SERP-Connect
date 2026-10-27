import { randomUUID } from "node:crypto";

const SENSITIVE_KEY =
  /token|secret|authorization|password|cookie|api[-_]?key|private[-_]?key|refresh|credential|service[-_]?role|^code$|auth[-_]?code|verifier|^state$|ciphertext|wrapped[-_]?dek|email/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const GOOGLE_TOKEN = /\bya29\.[A-Za-z0-9._-]+/g;
const GOOGLE_REFRESH = /\b1\/\/[A-Za-z0-9._-]{20,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
/** Credentials carried in a URL query string or form body (`?apikey=...`, `access_token=...`), as the Bing API key is. */
const QUERY_SECRET = /((?:^|[?&;\s"'])(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|token|code|password)=)[^&\s"'#]+/gi;
const DB_URL = /\b(postgres(?:ql)?|https?):\/\/[^\s:@/]+:[^\s@/]+@/gi;

export const REDACTED = "[REDACTED]";

/** Deep-redacts secrets by key name and by common token shapes in strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") {
    return value
      .replace(BEARER, `Bearer ${REDACTED}`)
      .replace(GOOGLE_TOKEN, REDACTED)
      .replace(GOOGLE_REFRESH, REDACTED)
      .replace(JWT, REDACTED)
      .replace(QUERY_SECRET, `$1${REDACTED}`)
      .replace(DB_URL, (_m, scheme: string) => `${scheme}://${REDACTED}@`);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1)]),
    );
  }
  return value;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  /** Injectable for tests. */
  write?: (line: string) => void;
}

/** Structured JSON-lines logger; every field passes through redact(). */
export function createLogger(options: LoggerOptions = {}): Logger {
  const min = ORDER[options.level ?? "info"];
  const bindings = options.bindings ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    write(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        msg,
        ...(redact({ ...bindings, ...fields }) as Record<string, unknown>),
      }),
    );
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => createLogger({ ...options, bindings: { ...bindings, ...b } }),
  };
}

export function newRequestId(): string {
  return randomUUID();
}
