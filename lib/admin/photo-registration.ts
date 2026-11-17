import { type DbError, type DbResult, type RetryOptions } from "@/lib/db/retry";

/*
 * Recording an uploaded photo (admin_add_product_image) when its answer may
 * be lost. The photo is already in Storage; the question is whether the
 * database recorded it, because deleting the file of a recorded photo leaves
 * the listing pointing at nothing.
 *
 * The call is keyed by the image id the website made for the upload
 * (supabase/migrations/20261117120300_idempotent_photo_registration.sql):
 * repeating it is safe, returns the first result if that committed, and
 * waits for a first call still in progress. So the way to find out what
 * happened to a call without an answer is to make it again:
 *
 *   recorded  the database answered with the product's new version
 *   refused   the database answered with an error (a database or PostgREST
 *             code): that transaction rolled back, and every earlier attempt
 *             either rolled back too or would have made this one succeed
 *             (except an access refusal, which comes before the function
 *             looks for the image: after an unanswered attempt that is
 *             "unknown"). Nothing was recorded; the file may be deleted.
 *   unknown   at least one attempt got no answer (network error, gateway
 *             error without a database code) and no later attempt settled
 *             it. The photo may be recorded: the file is KEPT.
 */

export type RegistrationOutcome =
  | { kind: "recorded"; version: number; attempts: number }
  | { kind: "refused"; error: DbError; attempts: number }
  | { kind: "unknown"; error: DbError; attempts: number };

/** An answer from the database itself: a SQLSTATE (e.g. PT409, 42501, 23505) or a PostgREST code. */
export function isDatabaseAnswer(error: DbError | null | undefined): boolean {
  return !!error?.code && (/^[0-9A-Z]{5}$/.test(error.code) || error.code.startsWith("PGRST"));
}

// Database answers that mean "rolled back, try again": serialization
// failure, deadlock, lock timeout.
const TRY_AGAIN = new Set(["40001", "40P01", "55P03"]);

const DEFAULT_DELAYS = [150, 400, 900, 1500];

export async function registerPhoto(
  register: () => PromiseLike<DbResult<number>>,
  options: RetryOptions = {},
): Promise<RegistrationOutcome> {
  const delays = options.delays ?? DEFAULT_DELAYS;
  const budget = options.budgetMs ?? 5000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  let unanswered = false;

  for (let attempt = 1; ; attempt++) {
    let result: DbResult<number>;
    try {
      result = await register();
    } catch (error) {
      result = { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
    }
    if (!result.error && typeof result.data === "number") return { kind: "recorded", version: result.data, attempts: attempt };
    const error = result.error ?? { message: "no answer" };

    const answered = isDatabaseAnswer(error);
    if (answered && !TRY_AGAIN.has(error.code!)) {
      // An access refusal (42501) or a PostgREST error (an expired token, ...)
      // is decided before the function looks for the image, so after an
      // unanswered attempt it says nothing about that one.
      const settles = !unanswered || !(error.code === "42501" || error.code!.startsWith("PGRST"));
      return { kind: settles ? "refused" : "unknown", error, attempts: attempt };
    }
    if (!answered) unanswered = true;

    const delay = delays[attempt - 1];
    if (delay === undefined || now() - started + delay > budget) {
      return { kind: unanswered ? "unknown" : "refused", error, attempts: attempt };
    }
    await sleep(delay);
  }
}

/** registerPhoto, then removes the uploaded file only if the database refused it. */
export async function recordUploadedPhoto(
  register: () => PromiseLike<DbResult<number>>,
  removeUpload: () => Promise<void>,
  options: RetryOptions = {},
): Promise<RegistrationOutcome> {
  const outcome = await registerPhoto(register, options);
  if (outcome.kind === "refused") await removeUpload();
  return outcome;
}
