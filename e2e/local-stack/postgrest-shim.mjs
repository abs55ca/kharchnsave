// A minimal stand-in for Supabase's HTTP API, for the local test stack only
// (scripts/e2e-checkout-local.mjs). It is NOT PostgREST and NOT Supabase
// Auth: it answers just the requests the site makes, against a real
// PostgreSQL database with every migration applied:
//
//   POST /rest/v1/rpc/<function>   calls public.<function>(named args) in its
//                                  own transaction, the way PostgREST does: as
//                                  anon, or as authenticated with the JWT's
//                                  claims when the request carries a valid
//                                  stand-in session; errors come back as
//                                  { code, message, details, hint }
//   GET  /rest/v1/products         the published catalogue (as anon), shaped
//                                  like the storefront's select
//   GET  /rest/v1/products?select=…publication_status…
//                                  the admin product list (as the caller):
//                                  status filter, search, order, page, count
//   GET  /rest/v1/admin_members    the admin access check (as the caller)
//   GET  /rest/v1/product_images?select=storage_path&id=eq.…&product_id=eq.…
//                                  a photo's stored path (as the caller): the
//                                  admin photo preview and photo flip lookup
//   GET  /rest/v1/product_variants?select=product_id,size_eu&product_id=in.(…)
//                                  sizes of products (as the caller): the
//                                  Pricing page's "Sizes in this group"
//   GET  /rest/v1/orders?id=eq.<id> one order with its items and history, the
//                                  admin order page's read (as the caller, so
//                                  only a verified admin gets a row)
//
// Auth stand-in (only with `authSecret`; sessions are HS256 JWTs signed with
// it, which supabase-js verifies by calling GET /auth/v1/user):
//   POST /auth/v1/token?grant_type=password|refresh_token
//   GET  /auth/v1/user, PUT /auth/v1/user (password), POST /auth/v1/logout
//   POST /auth/v1/verify { token_hash, type }        one-time links
//   POST /auth/v1/recover                            answers 200, sends nothing
//   POST /auth/v1/admin/generate_link (secret key)   invite | recovery
// Users are rows in the stand-in auth.users; an admin_members row makes the
// user report a verified authenticator factor. No email, MFA codes, rate
// limits or the many other things real Auth does.
//
// Storage stand-in, the private "product-photos" bucket only, in memory, with
// the bucket's access rules (20261029120000_admin_product_management.sql):
//   POST   /storage/v1/object/product-photos/<path>   upload: verified admins,
//          new objects only at <existing product id>/<uuid>.webp
//   GET    /storage/v1/object/product-photos/<path>   download: verified admins,
//          or anyone while a published product uses the photo
//   DELETE /storage/v1/object/product-photos { prefixes }   verified admins
//   POST   /storage/v1/object/list/product-photos { prefix }   verified admins
// Not Storage itself: no other buckets, signed URLs, transforms or quotas.
//
// Anything else is answered 404. Listens on 127.0.0.1 only.

import http from "node:http";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import pg from "pg";

const CATALOGUE = `
  select coalesce(json_agg(row_to_json(x) order by x.listed_at desc), '[]'::json) as body from (
    select p.id, p.item_code, p.slug, p.name, p.brand, p.department, p.styles, p.item_status, p.condition,
      p.condition_notes, p.colour, p.description, p.price_paisa, p.sale_price_paisa, p.reference_price_paisa,
      p.referral_excluded, p.listed_at,
      coalesce((select json_agg(json_build_object('sku', v.sku, 'size_eu', v.size_eu, 'stock', v.stock))
                from public.product_variants v where v.product_id = p.id), '[]'::json) as product_variants,
      coalesce((select json_agg(json_build_object('src', i.src, 'storage_path', i.storage_path, 'alt', i.alt,
                  'width', i.width, 'height', i.height, 'sort_order', i.sort_order, 'focus', i.focus,
                  'shows_defect', i.shows_defect) order by i.sort_order)
                from public.product_images i where i.product_id = p.id), '[]'::json) as product_images
    from public.products p where p.publication_status = 'published'
  ) x`;

function status(code) {
  if (/^PT\d{3}$/.test(code)) return Number(code.slice(2));
  if (code === "42501") return 401;
  if (code === "42883" || code === "PGRST202") return 404;
  if (code?.startsWith("23")) return 409;
  return 400;
}

const b64url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** An HS256 session token like Supabase's (also used by the tests to sign in an admin). */
export function signSessionToken(secret, { sub, email, aal = "aal1", ttl = 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ sub, email, role: "authenticated", aud: "authenticated", aal, session_id: randomUUID(), iat: now, exp: now + ttl });
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}

function verifyToken(secret, token) {
  if (!secret || typeof token !== "string") return null;
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  return claims.exp > Date.now() / 1000 && claims.role === "authenticated" ? claims : null;
}

export async function startShim({ connection, port, authSecret = null, serviceKey = null }) {
  const pool = new pg.Pool({ ...connection, max: 30 });
  pool.on("connect", (client) => client.on("notice", () => {}));
  const signatures = new Map();
  // Stand-in Auth state (in memory): passwords, one-time links, refresh tokens.
  const passwords = new Map(); // user id -> sha256(password)
  const links = new Map(); // hashed token -> { userId, type }
  const refreshTokens = new Map(); // token -> { userId, aal }

  async function argumentTypes(name) {
    if (!signatures.has(name)) {
      const { rows } = await pool.query(
        `select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [name]);
      signatures.set(name, rows[0] ?? null);
    }
    return signatures.get(name);
  }

  async function as(claims, sql, params) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${claims ? "authenticated" : "anon"}`);
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims ?? { role: "anon" })]);
      const result = await client.query(sql, params);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  const send = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const authError = (res, code, errorCode, msg) => send(res, code, { code, error_code: errorCode, msg });
  const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
  const callerClaims = (req) => verifyToken(authSecret, bearer(req));
  const hash = (password) => createHash("sha256").update(password).digest("hex");

  async function userJson(id) {
    const { rows } = await pool.query(
      `select u.id, u.email, exists (select 1 from public.admin_members m where m.user_id = u.id) as admin
       from auth.users u where u.id = $1`, [id]);
    if (!rows[0]) return null;
    return {
      id: rows[0].id, aud: "authenticated", role: "authenticated", email: rows[0].email,
      app_metadata: { provider: "email" }, user_metadata: {}, created_at: new Date().toISOString(),
      factors: rows[0].admin ? [{ id: randomUUID(), factor_type: "totp", status: "verified", friendly_name: "stand-in" }] : [],
    };
  }

  async function session(userId, aal = "aal1") {
    const user = await userJson(userId);
    const refresh = randomBytes(24).toString("base64url");
    refreshTokens.set(refresh, { userId, aal });
    return {
      access_token: signSessionToken(authSecret, { sub: userId, email: user.email, aal }),
      token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refresh, user,
    };
  }

  // Storage stand-in: object path -> { data, type }.
  const BUCKET = "product-photos";
  const objects = new Map();
  const OBJECT_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
  const storageError = (res, code, error, message) => send(res, code === 409 ? 400 : code, { statusCode: String(code), error, message });

  async function isAdmin(claims) {
    if (!claims) return false;
    const { rows } = await as(claims, "select public.is_catalogue_admin() as ok", []);
    return rows[0].ok === true;
  }

  async function storage(req, res, url) {
    const claims = callerClaims(req);
    const rest = url.pathname.slice("/storage/v1/object/".length);
    if (req.method === "POST" && rest === `list/${BUCKET}`) {
      if (!(await isAdmin(claims))) return send(res, 200, []);
      const prefix = String((await readBody(req)).prefix ?? "").replace(/\/$/, "");
      const names = [...objects.keys()].filter((name) => name.startsWith(`${prefix}/`)).map((name) => name.slice(prefix.length + 1));
      return send(res, 200, names.filter((n) => !n.includes("/")).map((name) => ({ name, id: randomUUID(), metadata: {} })));
    }
    if (req.method === "DELETE" && rest === BUCKET) {
      if (!(await isAdmin(claims))) return send(res, 200, []);
      const removed = [];
      for (const name of (await readBody(req)).prefixes ?? []) if (objects.delete(name)) removed.push({ name, bucket_id: BUCKET });
      return send(res, 200, removed);
    }
    if (!rest.startsWith(`${BUCKET}/`)) return storageError(res, 404, "Bucket not found", "Bucket not found");
    const name = decodeURIComponent(rest.slice(BUCKET.length + 1));
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (!(await isAdmin(claims)) || !OBJECT_PATH.test(name)) return storageError(res, 403, "Unauthorized", "new row violates row-level security policy");
      const { rows } = await pool.query("select 1 from public.products where id::text = split_part($1, '/', 1)", [name]);
      if (rows.length === 0) return storageError(res, 403, "Unauthorized", "new row violates row-level security policy");
      if (objects.has(name)) return storageError(res, 409, "Duplicate", "The resource already exists");
      objects.set(name, { data: Buffer.concat(chunks), type: req.headers["content-type"] ?? "application/octet-stream" });
      return send(res, 200, { Id: randomUUID(), Key: `${BUCKET}/${name}` });
    }
    if (req.method === "GET") {
      const object = objects.get(name);
      let allowed = object && (await isAdmin(claims));
      if (object && !allowed) {
        const { rows } = await as(claims, `select exists (select 1 from public.product_images i join public.products p on p.id = i.product_id
          where i.storage_path = $1 and p.publication_status = 'published') as ok`, [name]);
        allowed = rows[0].ok;
      }
      if (!allowed) return storageError(res, 404, "not_found", "Object not found");
      res.writeHead(200, { "content-type": object.type });
      return res.end(object.data);
    }
    return storageError(res, 405, "Method not allowed", "Method not allowed");
  }

  async function readBody(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  }

  async function auth(req, res, url) {
    const path = url.pathname.slice("/auth/v1".length);
    if (req.method === "POST" && path === "/token") {
      const body = await readBody(req);
      if (url.searchParams.get("grant_type") === "password") {
        const { rows } = await pool.query("select id from auth.users where lower(email) = lower($1)", [body.email ?? ""]);
        const id = rows[0]?.id;
        if (!id || passwords.get(id) !== hash(body.password ?? "")) return authError(res, 400, "invalid_credentials", "Invalid login credentials");
        return send(res, 200, await session(id));
      }
      const refresh = refreshTokens.get(body.refresh_token);
      if (!refresh) return authError(res, 400, "refresh_token_not_found", "Invalid Refresh Token");
      refreshTokens.delete(body.refresh_token);
      return send(res, 200, await session(refresh.userId, refresh.aal));
    }
    if (path === "/user" && (req.method === "GET" || req.method === "PUT")) {
      const claims = callerClaims(req);
      const user = claims ? await userJson(claims.sub) : null;
      if (!user) return authError(res, 401, "bad_jwt", "invalid JWT");
      if (req.method === "PUT") {
        const body = await readBody(req);
        if (typeof body.password === "string") passwords.set(user.id, hash(body.password));
      }
      return send(res, 200, user);
    }
    if (req.method === "POST" && path === "/logout") return send(res, 204);
    if (req.method === "POST" && path === "/recover") return send(res, 200, {});
    if (req.method === "POST" && path === "/verify") {
      const body = await readBody(req);
      const link = links.get(body.token_hash);
      if (!link || link.type !== body.type) return authError(res, 403, "otp_expired", "Email link is invalid or has expired");
      links.delete(body.token_hash);
      return send(res, 200, await session(link.userId));
    }
    if (req.method === "POST" && path === "/admin/generate_link") {
      if (!serviceKey || bearer(req) !== serviceKey) return authError(res, 403, "not_admin", "User not allowed");
      const body = await readBody(req);
      const { rows } = await pool.query("select id from auth.users where lower(email) = lower($1)", [body.email ?? ""]);
      let id = rows[0]?.id;
      if (body.type === "invite") {
        if (id) return authError(res, 422, "email_exists", "A user with this email address has already been registered");
        id = randomUUID();
        await pool.query("insert into auth.users (id, email) values ($1, $2)", [id, String(body.email).toLowerCase()]);
      } else if (!id) {
        return authError(res, 404, "user_not_found", "User not found");
      }
      const token = randomBytes(24).toString("hex");
      links.set(token, { userId: id, type: body.type });
      return send(res, 200, { ...(await userJson(id)), action_link: "", email_otp: "", hashed_token: token, redirect_to: "", verification_type: body.type });
    }
    return send(res, 404, { code: 404, msg: "not found" });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (url.pathname.startsWith("/auth/v1/") && authSecret) return await auth(req, res, url);
      if (url.pathname.startsWith("/storage/v1/object/") && authSecret) return await storage(req, res, url);
      if (req.method === "GET" && url.pathname === "/rest/v1/products" && (url.searchParams.get("select") ?? "").includes("publication_status")) {
        // The admin product list (lib/admin/products.ts listProducts), as the caller: status filter,
        // search words (each an "or" of ilike conditions), newest first, a page (offset/limit), and the count.
        const params = [];
        const where = [];
        const status = /^eq\.(draft|published|archived)$/.exec(url.searchParams.get("publication_status") ?? "")?.[1];
        if (status) {
          params.push(status);
          where.push(`p.publication_status = $${params.length}`);
        }
        for (const or of url.searchParams.getAll("or")) {
          const word = /^\(name\.ilike\.%(.*?)%,/.exec(or)?.[1];
          if (word === undefined) return send(res, 400, { code: "PGRST100", message: "unsupported filter", details: null, hint: null });
          params.push(`%${word}%`);
          const n = params.length;
          where.push(`(p.name ilike $${n} or p.brand ilike $${n} or p.item_code ilike $${n} or p.slug ilike $${n} or p.colour ilike $${n})`);
        }
        const filter = where.length ? `where ${where.join(" and ")}` : "";
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        const limit = Math.max(0, Number(url.searchParams.get("limit") ?? 1000) || 0);
        const claims = callerClaims(req);
        const { rows } = await as(claims, `
          select coalesce(json_agg(x order by x.updated_at desc, x.id), '[]'::json) as body from (
            select p.id, p.item_code, p.name, p.brand, p.publication_status, p.item_status, p.price_paisa, p.sale_price_paisa, p.updated_at,
              coalesce((select json_agg(json_build_object('stock', v.stock)) from public.product_variants v where v.product_id = p.id), '[]'::json) as product_variants,
              coalesce((select json_agg(json_build_object('id', i.id, 'src', i.src, 'storage_path', i.storage_path, 'sort_order', i.sort_order))
                        from public.product_images i where i.product_id = p.id), '[]'::json) as product_images
            from public.products p ${filter}
            order by p.updated_at desc, p.id offset ${offset} limit ${limit}
          ) x`, params);
        const total = (await as(claims, `select count(*)::int as n from public.products p ${filter}`, params)).rows[0].n;
        const body = rows[0].body;
        res.writeHead(200, { "content-type": "application/json", "content-range": `${offset}-${offset + Math.max(body.length - 1, 0)}/${total}` });
        return res.end(JSON.stringify(body));
      }
      if (req.method === "GET" && url.pathname === "/rest/v1/products") {
        const { rows } = await as(null, CATALOGUE, []);
        return send(res, 200, rows[0].body);
      }
      if (req.method === "GET" && url.pathname === "/rest/v1/admin_members") {
        const filter = /^eq\.([0-9a-f-]{36})$/.exec(url.searchParams.get("user_id") ?? "");
        if (!filter) return send(res, 400, { code: "PGRST100", message: "unsupported filter", details: null, hint: null });
        const { rows } = await as(callerClaims(req), "select user_id from public.admin_members where user_id = $1", [filter[1]]);
        return send(res, 200, rows);
      }
      if (req.method === "GET" && url.pathname === "/rest/v1/product_variants") {
        // The Pricing page's "Sizes in this group" read (as the caller, so RLS applies).
        const ids = /^in\.\(([0-9a-f,-]*)\)$/.exec(url.searchParams.get("product_id") ?? "")?.[1]?.split(",").filter(Boolean);
        if (!ids || url.searchParams.get("select") !== "product_id,size_eu") {
          return send(res, 400, { code: "PGRST100", message: "unsupported query", details: null, hint: null });
        }
        const { rows } = await as(callerClaims(req), "select product_id, size_eu from public.product_variants where product_id = any($1::uuid[])", [ids]);
        return send(res, 200, rows);
      }
      if (req.method === "GET" && url.pathname === "/rest/v1/product_images") {
        // The admin photo preview's and the photo flip's lookup (as the caller, so RLS applies).
        const id = /^eq\.([0-9a-f-]{36})$/.exec(url.searchParams.get("id") ?? "")?.[1];
        const productId = /^eq\.([0-9a-f-]{36})$/.exec(url.searchParams.get("product_id") ?? "")?.[1];
        if (!id || !productId || url.searchParams.get("select") !== "storage_path") {
          return send(res, 400, { code: "PGRST100", message: "unsupported query", details: null, hint: null });
        }
        const { rows } = await as(callerClaims(req), "select storage_path from public.product_images where id = $1 and product_id = $2", [id, productId]);
        return send(res, 200, rows);
      }
      if (req.method === "GET" && url.pathname === "/rest/v1/orders") {
        const filter = /^eq\.([0-9a-f-]{36})$/.exec(url.searchParams.get("id") ?? "");
        if (!filter || !(url.searchParams.get("select") ?? "").includes("order_items")) {
          return send(res, 400, { code: "PGRST100", message: "unsupported query", details: null, hint: null });
        }
        const { rows } = await as(callerClaims(req), `
          select coalesce(json_agg(x), '[]'::json) as body from (
            select o.*,
              coalesce((select json_agg(row_to_json(i) order by i.line_no) from public.order_items i where i.order_id = o.id), '[]'::json) as order_items,
              coalesce((select json_agg(row_to_json(e) order by e.id) from public.order_events e where e.order_id = o.id), '[]'::json) as order_events
            from public.orders o where o.id = $1
          ) x`, [filter[1]]);
        return send(res, 200, rows[0].body);
      }
      const rpc = /^\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)$/.exec(url.pathname);
      if ((req.method === "POST" || req.method === "GET") && rpc) {
        const args = req.method === "POST" ? await readBody(req) : Object.fromEntries(url.searchParams);
        const signature = await argumentTypes(rpc[1]);
        if (!signature) return send(res, 404, { code: "PGRST202", message: "function not found", details: null, hint: null });
        const params = [];
        const named = Object.entries(args).map(([name, value]) => {
          const index = signature.names?.indexOf(name) ?? -1;
          if (index < 0) throw Object.assign(new Error(`unknown argument ${name}`), { code: "PGRST202" });
          const type = signature.types[index];
          params.push(value === null ? null : type === "jsonb" || type === "json" ? JSON.stringify(value)
            : type.endsWith("[]") ? `{${value.join(",")}}` : String(value));
          return `"${name}" := $${params.length}::${type}`;
        });
        const { rows } = await as(callerClaims(req), `select public."${rpc[1]}"(${named.join(", ")}) as r`, params);
        return send(res, 200, rows[0].r);
      }
      return send(res, 404, { code: "PGRST205", message: "not found", details: null, hint: null });
    } catch (error) {
      return send(res, status(error.code), {
        code: error.code ?? "",
        message: error.message,
        details: error.detail ?? null,
        hint: error.hint ?? null,
      });
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}
