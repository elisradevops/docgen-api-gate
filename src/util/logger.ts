import * as winston from "winston";
import * as fs from "fs";
import * as path from "path";
import { runContextStore } from "./runContext";

// Merges the ambient runId (set by attachRunContext, wrapping each request in
// runContextStore.run(...)) into every log record emitted while handling that request.
export const withRunContext = winston.format((info) => {
  const runId = runContextStore.getStore()?.runId;
  if (runId) (info as Record<string, unknown>).runId = runId;
  return info;
});

// Defense-in-depth: scrubs known-sensitive keys out of any object attached to a log
// call (meta, splat, an Error's own enumerable props — e.g. AxiosError.toJSON()'s
// config.auth.password) so a secret making it into a logger call doesn't also make it
// into the log stream. This does not redact secrets interpolated into a message string
// (see the corresponding call-site fixes) — it's a backstop for structured fields.
const SENSITIVE_KEY = /token|pat|password|secret|authorization|minioaccesskey|miniosecretkey/i;

// A per-key try/catch on the *read*, not just around the whole loop: a getter that throws
// (e.g. `{ get boom() { throw ... } }`) would otherwise abort redaction for every remaining
// key in the same object, or — worse — survive redaction untouched and re-throw later, inside
// winston's json() formatter, which is not wrapped in anything. redactValue always returns a
// freshly built plain object/array, never the original reference, so once a value has passed
// through here nothing downstream can re-trigger a throwing accessor on it.
function safeRead(obj: Record<string, unknown>, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: obj[key] };
  } catch {
    return { ok: false };
  }
}
function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const read = safeRead(value as Record<string, unknown>, key);
    if (!read.ok) {
      out[key] = "[Unreadable property]";
      continue;
    }
    out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(read.value, depth + 1, seen);
  }
  return out;
}
export const redact = winston.format((info) => {
  const target = info as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    // level/timestamp are always plain strings winston sets itself — never touched. message is
    // NOT exempt: when logger.error(x) is called with a single non-string/non-Error argument,
    // winston nests the whole thing under info.message (this is exactly the shape hit by a raw
    // object argument), so message can carry a throwing getter or a sensitive key just as much
    // as any other field — redactValue already no-ops on a plain string, so including it here
    // costs nothing for the common case and closes that gap for the uncommon one.
    if (key === "level" || key === "timestamp") continue;
    const read = safeRead(target, key);
    const value = !read.ok
      ? "[Unreadable property]"
      : // A top-level primitive (e.g. token: "abc") has no children for redactValue to walk into —
        // the key itself has to be checked here too, not just inside the recursive object walk.
        SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : redactValue(read.value);
    try {
      target[key] = value;
    } catch {
      // The original property could be a getter-only accessor with no setter, which throws on
      // plain assignment in strict mode — redefine it outright rather than skip it.
      Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
  return info;
});

// Resolves the service's own version for defaultMeta. Mirrors JsonDocRoutes.ts's own
// resilient package.json lookup (dev runs from src/, the built image runs from bin/ with
// package.json copied alongside it — the exact relative path differs between the two).
function readOwnVersion(): string {
  const candidates = [
    path.resolve(__dirname, "../package.json"),
    path.resolve(__dirname, "../../package.json"),
    path.resolve(process.cwd(), "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      return JSON.parse(fs.readFileSync(candidate, "utf8")).version || "unknown";
    } catch {
      // try next candidate
    }
  }
  return "unknown";
}

const textFormat = winston.format.printf(
  (info) => `${info.timestamp} - ${info.level}: ${info.message}`
);

// LOG_FORMAT=json is the eventual default (structured stdout a collector can parse), but
// stays opt-in for one release so switching is a config change, not an image rebuild, if
// anyone reading raw console output needs to roll back.
const useJson = (process.env.LOG_FORMAT || "text").toLowerCase() === "json";

const logger: winston.Logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  defaultMeta: { service: "dg-api-gate", version: readOwnVersion() },
  format: useJson
    ? winston.format.combine(
        winston.format.errors({ stack: true }),
        winston.format.timestamp(),
        withRunContext(),
        redact(),
        winston.format.splat(),
        winston.format.json()
      )
    : winston.format.combine(
        winston.format.errors({ stack: true }),
        winston.format.timestamp(),
        withRunContext(),
        redact(),
        winston.format.splat(),
        textFormat
      ),
  // Stdout only — no File transports. There is no mounted log volume in this deployment
  // (no `logs_path`/volume is configured anywhere), so a File transport writes to the
  // container's ephemeral layer: invisible to `kubectl logs`, gone on restart, unrotated
  // until disk pressure evicts the pod. Under a read-only root filesystem (plausible
  // hardening for an accredited on-prem cluster) it throws at import time instead, which
  // is worse. `kubectl logs` is the only viewer that matters here.
  transports: [new winston.transports.Console()],
});

export default logger;
