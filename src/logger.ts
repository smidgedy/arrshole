import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: [
      "*.password", "*.apiKey", "*.token", "*.secret", "*.key",
      "*.*.password", "*.*.apiKey", "*.*.token", "*.*.secret", "*.*.key",
    ],
  });
}
