import "server-only";

/* Small helpers for the checkout Route Handlers. */

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

/** The request body as JSON, or null if it's missing, too large or malformed. */
export async function readJson(request: Request, maxBytes = 16_384): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
