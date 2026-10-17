import { Prisma } from "@prisma/client/extension";

/**
 * Prisma error codes where the query never reached the database:
 *
 * - P1001: can't reach the database server;
 * - P1017: the server closed the connection;
 * - P2024: timed out waiting for a free connection from the pool.
 */
export const DEFAULT_RETRY_CODES: readonly string[] = ["P1001", "P1017", "P2024"];

export interface RetryInfo {
  /** 1 for the first retry, 2 for the second, and so on. */
  attempt: number;
  /** The connection error that triggered this retry. */
  error: unknown;
  /** How long we wait before running the query again. */
  delayMs: number;
}

export interface ColdStartRetryOptions {
  /** How many times to retry after the first failure. Default: 1. */
  retries?: number;
  /** Wait before each retry, in milliseconds. Default: 600. */
  delayMs?: number;
  /** Error codes treated as connection failures. Default: DEFAULT_RETRY_CODES. */
  codes?: readonly string[];
  /** Also retry PrismaClientInitializationError (engine couldn't connect). Default: true. */
  retryInitializationErrors?: boolean;
  /** Called before each retry, e.g. for logging. */
  onRetry?: (info: RetryInfo) => void;
}

interface ResolvedOptions {
  retries: number;
  delayMs: number;
  codes: ReadonlySet<string>;
  retryInitializationErrors: boolean;
  onRetry?: (info: RetryInfo) => void;
}

function resolveOptions(options: ColdStartRetryOptions = {}): ResolvedOptions {
  const retries = options.retries ?? 1;
  const delayMs = options.delayMs ?? 600;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError(`retries must be a non-negative integer, got ${retries}`);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError(`delayMs must be a non-negative number, got ${delayMs}`);
  }
  return {
    retries,
    delayMs,
    codes: new Set(options.codes ?? DEFAULT_RETRY_CODES),
    retryInitializationErrors: options.retryInitializationErrors ?? true,
    onRetry: options.onRetry,
  };
}

/**
 * Whether `error` is a Prisma connection failure.
 *
 * Checks the error's `name` instead of `instanceof`, so it works no matter which copy of
 * the Prisma runtime threw it (custom client output paths, multiple clients, bundlers).
 */
export function isConnectionError(
  error: unknown,
  options: Pick<ColdStartRetryOptions, "codes" | "retryInitializationErrors"> = {},
): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (name === "PrismaClientKnownRequestError") {
    return typeof code === "string" && (options.codes ?? DEFAULT_RETRY_CODES).includes(code);
  }
  if (name === "PrismaClientInitializationError") {
    return options.retryInitializationErrors ?? true;
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, and runs it again when it fails with a connection error.
 * Any other error (unique constraint, record not found, validation...) is rethrown at once.
 */
export async function withConnectionRetry<T>(
  fn: () => Promise<T>,
  options?: ColdStartRetryOptions,
): Promise<T> {
  const opts = resolveOptions(options);
  const check = { codes: [...opts.codes], retryInitializationErrors: opts.retryInitializationErrors };
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= opts.retries || !isConnectionError(error, check)) throw error;
      opts.onRetry?.({ attempt: attempt + 1, error, delayMs: opts.delayMs });
      await sleep(opts.delayMs);
    }
  }
}

/**
 * Prisma Client extension that retries queries failing because the database was asleep
 * (Neon, Supabase, PlanetScale and other serverless databases that scale to zero) or
 * briefly unreachable.
 *
 * @example
 * const prisma = new PrismaClient().$extends(coldStartRetry());
 */
export function coldStartRetry(options?: ColdStartRetryOptions) {
  // Validate eagerly so a bad option fails at startup, not on the first query.
  resolveOptions(options);
  return Prisma.defineExtension({
    name: "prisma-cold-start-retry",
    query: {
      async $allOperations({ args, query }) {
        return withConnectionRetry(() => query(args), options);
      },
    },
  });
}

export default coldStartRetry;
