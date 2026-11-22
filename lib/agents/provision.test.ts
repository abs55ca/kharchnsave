import { describe, expect, it, vi } from "vitest";
import type { DbResult } from "@/lib/db/retry";
import { loginLinkUrl, provisionAgent, type AgentInput, type AgentRecord, type CreateResult, type GeneratedLink, type LinkResult, type ProvisionDeps } from "./provision";

/*
 * The provisioning sequence against fakes of the database and Supabase Auth
 * that behave like the real ones: Auth refuses a second user with the same
 * email; the database keys agents by request id and email. The database side
 * itself is tested on PostgreSQL in db-tests/referrals.test.ts.
 */

const INPUT: AgentInput = {
  username: "ahmed", display_name: "Ahmed Khan", email: "ahmed@test.invalid", code: "AHMED",
  discount_bp: 1000, commission_bp: 500, applies_to_sale_items: false, code_enabled: true,
};
const ok = <T,>(data: T): DbResult<T> => ({ data, error: null });

function world() {
  const agents = new Map<string, AgentRecord & { request: string }>();
  const authUsers = new Map<string, string>(); // email -> user id
  const admins = new Set<string>();
  const failures = { invite: 0, link: 0, recovery: 0, linkCrash: 0 };
  const links: string[] = [];
  const deps: ProvisionDeps = {
    createAgent: vi.fn(async (request: string, input: AgentInput) => {
      const same = [...agents.values()].find((a) => a.request === request);
      if (same) return ok<CreateResult>({ result: "existing", agent: same });
      const byEmail = [...agents.values()].find((a) => a.email === input.email);
      if (byEmail) return ok<CreateResult>({ result: "email_exists", agent_id: byEmail.id });
      const agent = { id: `agent-${agents.size + 1}`, email: input.email, user_id: null, access_status: "pending", code: input.code, version: 1, request };
      agents.set(agent.id, agent);
      return ok<CreateResult>({ result: "created", agent });
    }),
    linkAgent: vi.fn(async (id: string) => {
      if (failures.linkCrash > 0) {
        failures.linkCrash--;
        return { data: null, error: { code: "", message: "fetch failed" } };
      }
      const agent = agents.get(id)!;
      if (agent.user_id) return ok<LinkResult>({ result: "already_linked", agent });
      const user = authUsers.get(agent.email);
      if (!user) return ok<LinkResult>({ result: "no_auth_user" });
      if (admins.has(user)) return ok<LinkResult>({ result: "is_admin" });
      agent.user_id = user;
      agent.access_status = "active";
      return ok<LinkResult>({ result: "linked", agent });
    }),
    generateLink: vi.fn(async (type: "invite" | "recovery", email: string): Promise<GeneratedLink> => {
      if (type === "invite") {
        if (failures.invite > 0) {
          failures.invite--;
          return { ok: false, reason: "error" };
        }
        if (authUsers.has(email)) return { ok: false, reason: "exists" };
        authUsers.set(email, `user-${authUsers.size + 1}`);
        return { ok: true, tokenHash: `invite-${email}` };
      }
      if (failures.recovery > 0) {
        failures.recovery--;
        return { ok: false, reason: "error" };
      }
      return authUsers.has(email) ? { ok: true, tokenHash: `recovery-${email}` } : { ok: false, reason: "error" };
    }),
    noteLink: vi.fn(async (_id: string, _request: string, type: string) => void links.push(type)),
  };
  return { agents, authUsers, admins, failures, links, deps };
}

describe("provisioning a sales agent", () => {
  it("creates the agent, the login and an invitation link, and links them", async () => {
    const w = world();
    const result = await provisionAgent("req-1", INPUT, w.deps);
    expect(result).toEqual({ status: "ready", agentId: "agent-1", linkType: "invite", tokenHash: "invite-ahmed@test.invalid" });
    expect(w.agents.get("agent-1")).toMatchObject({ user_id: "user-1", access_status: "active" });
    expect(w.links).toEqual(["invite"]);
  });

  it("Auth fails: the agent stays pending, and the same request later finishes the job", async () => {
    const w = world();
    w.failures.invite = 1;
    expect(await provisionAgent("req-1", INPUT, w.deps)).toEqual({ status: "auth_failed", agentId: "agent-1" });
    expect(w.agents.get("agent-1")).toMatchObject({ user_id: null, access_status: "pending" });
    expect(await provisionAgent("req-1", INPUT, w.deps)).toMatchObject({ status: "ready", linkType: "invite" });
    expect(w.agents.size).toBe(1);
    expect(w.authUsers.size).toBe(1);
  });

  it("the login was created but linking failed: a retry links the same login and issues a password link (no duplicate user)", async () => {
    const w = world();
    w.failures.linkCrash = 1;
    expect((await provisionAgent("req-1", INPUT, w.deps)).status).toBe("db_error");
    expect(w.authUsers.size).toBe(1);
    // The admin submits the form again (a new request id).
    const again = await provisionAgent("req-2", INPUT, w.deps);
    expect(again).toEqual({ status: "email_exists", agentId: "agent-1" });
    // ...and the agent's page offers "Create password link", which reruns steps 2-4 for that agent.
    const retried = await provisionAgent("req-1", INPUT, w.deps);
    expect(retried).toEqual({ status: "ready", agentId: "agent-1", linkType: "recovery", tokenHash: "recovery-ahmed@test.invalid" });
    expect(w.authUsers.size).toBe(1);
    expect(w.agents.get("agent-1")?.user_id).toBe("user-1");
  });

  it("an email that belongs to an admin is never linked, and no password link is made for it", async () => {
    const w = world();
    w.authUsers.set(INPUT.email, "admin-user");
    w.admins.add("admin-user");
    expect(await provisionAgent("req-1", INPUT, w.deps)).toEqual({ status: "is_admin", agentId: "agent-1" });
    expect(w.deps.generateLink).not.toHaveBeenCalledWith("recovery", expect.anything());
    expect(w.links).toEqual([]);
  });

  it("an agent who already has a login gets a fresh password link", async () => {
    const w = world();
    await provisionAgent("req-1", INPUT, w.deps);
    expect(await provisionAgent("req-1", INPUT, w.deps)).toMatchObject({ status: "ready", linkType: "recovery" });
  });

  it("taken usernames and codes are reported without touching Auth", async () => {
    const w = world();
    w.deps.createAgent = vi.fn(async () => ok<CreateResult>({ result: "code_taken" }));
    expect(await provisionAgent("req-1", INPUT, w.deps)).toEqual({ status: "code_taken" });
    expect(w.deps.generateLink).not.toHaveBeenCalled();
  });

  it("the link opens our own confirmation page", () => {
    expect(loginLinkUrl("https://shop.example", "abc123", "invite")).toBe("https://shop.example/agent/auth/confirm?token_hash=abc123&type=invite");
  });
});
