# prisma-cold-start-retry

A [Prisma Client extension](https://www.prisma.io/docs/orm/prisma-client/client-extensions) that retries a query when it fails because **the database was asleep**.

Serverless Postgres providers such as Neon (and others that scale to zero) suspend idle databases. The first query after a pause wakes the database up, but it often fails because the connection isn't ready in time. Your first visitor gets a 500 error, and reloading the page works. This extension removes that failed first request.

## The problem, measured

I found this in a production app on Neon's free tier. After an idle period, `GET /api/products` returned **500 on the first call** and **200 on the next six** (0.4–0.8 s each). Retrying once after 600 ms fixed it.

## Install

```bash
npm install prisma-cold-start-retry
```

Requires `@prisma/client` 4.16 or newer (when client extensions became generally available). Tested with Prisma 5.22.

## Usage

```ts
import { PrismaClient } from "@prisma/client";
import { coldStartRetry } from "prisma-cold-start-retry";

export const prisma = new PrismaClient().$extends(coldStartRetry());
```

That's all. Each model query and raw query goes through the extension.

### Options

```ts
coldStartRetry({
  retries: 1,          // retries after the first failure (default 1)
  delayMs: 600,        // wait before each retry (default 600)
  codes: ["P1001", "P1017", "P2024"], // error codes treated as connection failures
  retryInitializationErrors: true,    // also retry PrismaClientInitializationError
  onRetry: ({ attempt, error, delayMs }) => console.warn(`DB retry #${attempt}`, error),
});
```

For code outside Prisma queries, the same logic is exported as a plain helper:

```ts
import { withConnectionRetry } from "prisma-cold-start-retry";
await withConnectionRetry(() => somethingThatUsesTheDb(), { retries: 2 });
```

## What it retries, and what it doesn't

It retries only **connection** failures:

| Error | Meaning |
|---|---|
| `PrismaClientInitializationError` | The engine couldn't connect (the typical "database is asleep" failure) |
| `P1001` | Can't reach the database server |
| `P1017` | The server closed the connection |
| `P2024` | Timed out waiting for a connection from the pool |

Every other error is rethrown at once, without a retry. That includes unique constraint violations, record-not-found errors and validation errors. These are real answers from the database, and retrying won't change them.

### Why one retry by default

Waking a sleeping database takes a few hundred milliseconds, so one retry is enough. If the database is really down, more retries only make the user wait longer for the same error. Raise `retries` if your provider needs more time to wake up.

## Caveats (please read)

- **Writes and `P1017`.** `P1001`, `P2024` and initialization errors happen before the query reaches the database, so retrying is always safe. `P1017` means the server closed the connection. That almost always happens before the query runs. In theory, though, a connection could drop *after* a write was committed but before the reply arrived. A retry would then run the write twice. If that matters for your app, remove `P1017` with `codes: ["P1001", "P2024"]`, or make your writes idempotent.
- **Transactions.** In an interactive `$transaction`, a lost connection kills the whole transaction. Retrying one query inside it won't save it. Handle that at the transaction level, for example with `withConnectionRetry(() => prisma.$transaction(...))`.
- This is not a general-purpose retry or backoff library. It targets one specific failure, and does that well.

## How errors are detected

The extension checks the error's `name` and `code`, not `instanceof`. Detection therefore works with custom client output paths, multiple generated clients and bundlers.

## Development

```bash
npm test                  # unit tests
npm run test:integration  # runs the extension inside a real PrismaClient against an unreachable database
```

## License

MIT
