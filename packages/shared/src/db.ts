import { Prisma, PrismaClient } from "@prisma/client";

export { Prisma, PrismaClient };

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: [{ emit: "stdout", level: "error" }],
  });
}

export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
