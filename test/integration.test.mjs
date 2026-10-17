// Runs the extension inside a real Prisma Client against a database that can't be reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { coldStartRetry } from "../dist/index.js";

test("a real Prisma query is retried on a connection failure, then the error surfaces", async () => {
  const retries = [];
  const prisma = new PrismaClient().$extends(
    coldStartRetry({ retries: 2, delayMs: 100, onRetry: (i) => retries.push(i) }),
  );
  try {
    await assert.rejects(prisma.item.findMany(), (err) =>
      ["PrismaClientInitializationError", "PrismaClientKnownRequestError"].includes(err.name),
    );
    assert.equal(retries.length, 2);
  } finally {
    await prisma.$disconnect();
  }
});
