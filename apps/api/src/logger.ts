import pino from "pino";

export const apiLog = pino({ level: process.env.LOG_LEVEL ?? "info", base: { service: "odin-api" } });
