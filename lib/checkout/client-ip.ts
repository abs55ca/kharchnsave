import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { ClientIpSource } from "./config";

/*
 * The visitor's IP, for rate limits only. It is read from the one header the
 * configured host sets itself (CLIENT_IP_SOURCE), never from a header the
 * visitor could choose. It is never stored or logged as is: the database
 * only sees an HMAC of it, keyed by the gateway secret.
 */

export function clientIp(headers: Headers, source: ClientIpSource | null): string | null {
  if (!source || source.kind === "none") return null;
  const value = headers.get(source.header)?.trim();
  // The configured header carries a single address.
  return value && isIP(value) ? value : null;
}

/** "ip:<hex>" for the rate-limit buckets, or null (one shared bucket). */
export function clientBucket(ip: string | null, secret: string): string | null {
  if (!ip) return null;
  const key = createHmac("sha256", secret).update("kharchnsave rate-limit ip v1").digest();
  return `ip:${createHmac("sha256", key).update(ip).digest("hex")}`;
}
