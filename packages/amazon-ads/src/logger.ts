import { createLogger } from "@amazon-king/observability";

/**
 * Minimal structured-logger shape used across this package. The pino logger
 * from @amazon-king/observability (with its secret redaction) satisfies it.
 */
export interface LoggerLike {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

let shared: LoggerLike | undefined;

/** Lazily-created package logger; pino redaction censors tokens/secrets/URLs. */
export function defaultLogger(): LoggerLike {
  shared ??= createLogger("amazon-ads");
  return shared;
}
