export function makeSilentLogger() {
  const logger: any = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => makeSilentLogger(),
    level: "silent",
  };
  return logger;
}
