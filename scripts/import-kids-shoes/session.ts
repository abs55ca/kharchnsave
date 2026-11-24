import { createInterface } from "node:readline";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Stops a script with a message for the person running it (no stack trace). */
export class ImportStopped extends Error {}

export function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Echo nothing while the password is typed.
    const muted = rl as unknown as { _writeToOutput: (s: string) => void };
    muted._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(question);
    };
  }
  return new Promise((done) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      done(answer.trim());
    }),
  );
}

/** The Supabase project in .env.local (its address is printed before anything is asked). */
export function projectFromEnv() {
  process.loadEnvFile(".env.local");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new ImportStopped(".env.local needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  return { url, key, project: new URL(url).host };
}

/** Signs in as a verified admin: email, password and the authenticator code (none are stored). */
export async function signInAdmin(url: string, key: string): Promise<SupabaseClient> {
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: true } });
  const email = await ask("Admin email: ");
  const password = await ask("Password: ", true);
  const signedIn = await supabase.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new ImportStopped(`Sign-in failed: ${signedIn.error.message}`);
  const factors = await supabase.auth.mfa.listFactors();
  const totp = factors.data?.totp.find((f) => f.status === "verified");
  if (!totp) throw new ImportStopped("This account has no verified authenticator app. Set up two-step verification in the admin first.");
  const code = await ask("6-digit code from your authenticator app: ");
  const verified = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code });
  if (verified.error) throw new ImportStopped(`Two-step verification failed: ${verified.error.message}`);
  const admin = await supabase.rpc("is_catalogue_admin");
  if (admin.error || admin.data !== true) throw new ImportStopped("This account isn't a verified admin of this shop.");
  console.log("Signed in as a verified admin.\n");
  return supabase;
}
