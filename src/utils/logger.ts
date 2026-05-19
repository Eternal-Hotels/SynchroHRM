export interface LogContext {
  [key: string]: unknown;
}

function write(level: "info" | "warn" | "error", message: string, context?: LogContext): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(context ?? {})
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

export const logger = {
  info(message: string, context?: LogContext) {
    write("info", message, context);
  },
  warn(message: string, context?: LogContext) {
    write("warn", message, context);
  },
  error(message: string, context?: LogContext) {
    write("error", message, context);
  }
};
