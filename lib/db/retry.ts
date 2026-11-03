/*
 * Bounded retries for database calls that are safe to repeat. Only the
 * order and stock functions use it, and only because every one of them is
 * idempotent: an order carries its checkout key, an admin action its request
 * id, so a repeat returns the first result instead of applying twice.
 *
 * Retried: serialization failures (40001), deadlocks (40P01), lock timeouts
 * (55P03) and network errors where we can't tell whether the call arrived.
 * At most three retries, after about 100, 250 and 600 ms (with jitter), and
 * never past a total budget of about 3 seconds.
 */

export type DbError = { code?: string; message?: string; hint?: string | null; details?: string | null };
export type DbResult<T> = { data: T | null; error: DbError | null };

export const RETRYABLE_CODES = new Set(["40001", "40P01", "55P03"]);
const NETWORK_ERROR = /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|aborted|timeout/i;

/** True when repeating the call might succeed and can't do harm. */
export function isRetryable(error: DbError | null | undefined): boolean {
  if (!error) return false;
  if (error.code && RETRYABLE_CODES.has(error.code)) return true;
  // supabase-js reports a failed request with an empty code.
  return !error.code && NETWORK_ERROR.test(error.message ?? "");
}

/** True when the call may or may not have reached the database. */
export function isUncertain(error: DbError | null | undefined): boolean {
  return !!error && !error.code && NETWORK_ERROR.test(error.message ?? "");
}

export type RetryOptions = {
  delays?: number[];
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

const DEFAULT_DELAYS = [100, 250, 600];

export async function withDbRetry<T>(
  run: () => PromiseLike<DbResult<T>>,
  options: RetryOptions = {},
): Promise<DbResult<T> & { attempts: number }> {
  const delays = options.delays ?? DEFAULT_DELAYS;
  const budget = options.budgetMs ?? 3000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const started = now();

  for (let attempt = 1; ; attempt++) {
    let result: DbResult<T>;
    try {
      result = await run();
    } catch (error) {
      result = { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
    }
    const delay = delays[attempt - 1];
    if (!isRetryable(result.error) || delay === undefined) return { ...result, attempts: attempt };
    const wait = Math.round(delay * (0.75 + random() * 0.5));
    if (now() - started + wait > budget) return { ...result, attempts: attempt };
    await sleep(wait);
  }
}
