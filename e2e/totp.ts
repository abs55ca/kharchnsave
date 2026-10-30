import { createHmac } from "node:crypto";

/** Base32 (RFC 4648), as authenticator app secrets are written. */
function base32Decode(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.toUpperCase().replace(/[\s=]/g, "");
  let bits = "";
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("The TOTP secret isn't valid base32.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => parseInt(byte, 2)));
}

/** The current 6-digit code (RFC 6238: SHA-1, 30-second steps), like an authenticator app. */
export function totp(secret: string, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}
