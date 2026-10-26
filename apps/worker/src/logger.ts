import pino from "pino";

export const workerLog = pino({ level: process.env.LOG_LEVEL ?? "info", base: { service: "odin-worker" } });
