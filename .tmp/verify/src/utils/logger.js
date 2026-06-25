function write(level, message, context) {
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
    info(message, context) {
        write("info", message, context);
    },
    warn(message, context) {
        write("warn", message, context);
    },
    error(message, context) {
        write("error", message, context);
    }
};
