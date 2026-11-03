// A minimal stand-in for Supabase's HTTP API (PostgREST), for the local
// checkout test stack only (scripts/e2e-checkout-local.mjs). It is NOT
// PostgREST: it answers just the two kinds of request the storefront and
// guest checkout make with the publishable key, against a real PostgreSQL
// database with every migration applied:
//
//   POST /rest/v1/rpc/<function>   calls public.<function>(named args) as the
//                                  anon role, in its own transaction, the way
//                                  PostgREST does; errors come back as
//                                  { code, message, details, hint }
//   GET  /rest/v1/products         the published catalogue (as anon), shaped
//                                  like the storefront's select
//
// Anything else is answered 404. Listens on 127.0.0.1 only.

import http from "node:http";
import pg from "pg";

const CATALOGUE = `
  select coalesce(json_agg(row_to_json(x) order by x.listed_at desc), '[]'::json) as body from (
    select p.id, p.item_code, p.slug, p.name, p.brand, p.department, p.styles, p.item_status, p.condition,
      p.condition_notes, p.colour, p.description, p.price_paisa, p.listed_at,
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

export async function startShim({ connection, port }) {
  const pool = new pg.Pool({ ...connection, max: 30 });
  pool.on("connect", (client) => client.on("notice", () => {}));
  const signatures = new Map();

  async function argumentTypes(name) {
    if (!signatures.has(name)) {
      const { rows } = await pool.query(
        `select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [name]);
      signatures.set(name, rows[0] ?? null);
    }
    return signatures.get(name);
  }

  async function asAnon(sql, params) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role anon");
      await client.query("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true)");
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
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/rest/v1/products") {
        const { rows } = await asAnon(CATALOGUE, []);
        return send(res, 200, rows[0].body);
      }
      const rpc = /^\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)$/.exec(url.pathname);
      if (req.method === "POST" && rpc) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const args = raw ? JSON.parse(raw) : {};
        const signature = await argumentTypes(rpc[1]);
        if (!signature) return send(res, 404, { code: "PGRST202", message: "function not found", details: null, hint: null });
        const params = [];
        const named = Object.entries(args).map(([name, value]) => {
          const index = signature.names?.indexOf(name) ?? -1;
          if (index < 0) throw Object.assign(new Error(`unknown argument ${name}`), { code: "PGRST202" });
          const type = signature.types[index];
          params.push(value === null ? null : type === "jsonb" || type === "json" ? JSON.stringify(value) : String(value));
          return `"${name}" := $${params.length}::${type}`;
        });
        const { rows } = await asAnon(`select public."${rpc[1]}"(${named.join(", ")}) as r`, params);
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
