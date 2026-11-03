// Creates the checkout gateway secret (README, "Checkout: setup").
//
//   node scripts/checkout-gateway-key.mjs [--env-file .env.local] [--replace]
//
// Writes a new random secret to CHECKOUT_GATEWAY_SECRET in the env file
// (never printed), then prints only its SHA-256 hash and the SQL that
// registers that hash in the database. Copy the secret itself from the env
// file to the host's environment settings when deploying.
//
// --replace overwrites an existing CHECKOUT_GATEWAY_SECRET (for rotation:
// register the new hash first, deploy, then retire the old one).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const envFile = args.includes("--env-file") ? args[args.indexOf("--env-file") + 1] : ".env.local";
const replace = args.includes("--replace");
const NAME = "CHECKOUT_GATEWAY_SECRET";

if (!envFile) {
  console.error("Usage: node scripts/checkout-gateway-key.mjs [--env-file .env.local] [--replace]");
  process.exit(1);
}

const current = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
const line = new RegExp(`^${NAME}=.*$`, "m");
if (line.test(current) && !replace) {
  console.error(`${envFile} already has ${NAME}. Use --replace to rotate it (see README).`);
  process.exit(1);
}

const secret = randomBytes(32).toString("base64url");
const updated = line.test(current)
  ? current.replace(line, `${NAME}=${secret}`)
  : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${NAME}=${secret}\n`;
writeFileSync(envFile, updated, { mode: 0o600 });

const hash = createHash("sha256").update(secret, "utf8").digest("hex");
const label = `website ${new Date().toISOString().slice(0, 10)}`;
console.log(`Wrote a new ${NAME} to ${envFile} (not shown).`);
console.log("\nRegister it in the Supabase SQL Editor (only the hash leaves this machine):\n");
console.log(`insert into private.checkout_gateway_keys (key_hash, label)\nvalues (decode('${hash}', 'hex'), '${label}');`);
