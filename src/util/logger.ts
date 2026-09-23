import * as winston from "winston";

let logsPath = process.env.logs_path || "./logs/";
const logFormat = winston.format.printf(
  (info) => `${info.timestamp} - ${info.level}: ${info.message}`
);

// Defense-in-depth: scrubs known-sensitive keys out of any object attached to a log
// call (meta, splat, an Error's own enumerable props — e.g. AxiosError.toJSON()'s
// config.auth.password) so a secret making it into a logger call doesn't also make it
// into the log stream. This does not redact secrets interpolated into a message string
// (see the corresponding call-site fixes) — it's a backstop for structured fields.
const SENSITIVE_KEY = /token|pat|password|secret|authorization|minioaccesskey|miniosecretkey/i;
function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : redactValue((value as Record<string, unknown>)[key], depth + 1, seen);
  }
  return out;
}
export const redact = winston.format((info) => {
  try {
    for (const key of Object.keys(info)) {
      if (key === "level" || key === "message" || key === "timestamp") continue;
      // A top-level primitive (e.g. token: "abc") has no children for redactValue to walk into —
      // the key itself has to be checked here too, not just inside the recursive object walk.
      (info as Record<string, unknown>)[key] = SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : redactValue((info as Record<string, unknown>)[key]);
    }
  } catch {
    // Redaction must never break logging itself.
  }
  return info;
});

const logger: winston.Logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.prettyPrint(),
    winston.format.errors({ stack: true }),
    redact()
  ),
  level: "silly",
  transports: [
    new winston.transports.File({
      filename: `${logsPath}minio-client.log`,
      level: "error",
      format: logFormat,
    }),
    new winston.transports.File({
      filename: `${logsPath}minio-client-all.log`,
      format: logFormat,
    }),
    new winston.transports.Console({ format: logFormat, level: "debug" }),
  ],
});

export default logger;
