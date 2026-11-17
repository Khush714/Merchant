type Fields = Record<string, unknown>;
type Level = "info" | "warn" | "error";

/** One JSON object per line so log drains can index event/requestId without parsing prose. */
function emit(level: Level, event: string, fields: Fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function log(event: string, fields: Fields = {}) { emit("info", event, fields); }
export function warn(event: string, fields: Fields = {}) { emit("warn", event, fields); }

/** Database and library errors can echo query parameters, so strip identifiers before logging. */
function sanitizeMessage(message: string) {
  return message
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .slice(0, 1000);
}

/** Never pass request bodies, headers or secrets here; only explicitly chosen safe fields. */
export function logError(event: string, error: unknown, fields: Fields = {}) {
  const detail: Record<string, string> = error instanceof Error
    ? { name: error.name, message: sanitizeMessage(error.message) }
    : { message: sanitizeMessage(String(error)) };
  if (error instanceof Error) {
    const digest = (error as Error & { digest?: string }).digest;
    if (digest) detail.digest = digest;
    if (process.env.NODE_ENV !== "production" && error.stack) detail.stack = error.stack;
  }
  emit("error", event, { ...fields, error: detail });
}
