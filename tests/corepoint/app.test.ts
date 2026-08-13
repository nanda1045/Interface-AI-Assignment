import request from "supertest";
import { describe, expect, it } from "vitest";
import { createCorePointApp } from "../../apps/corepoint/app.js";
import { tenants } from "../../apps/corepoint/tenants.js";

async function authenticatedAgent(tenantIndex = 0) {
  const tenant = tenants[tenantIndex];
  if (!tenant) throw new Error("Missing tenant fixture");
  const agent = request.agent(createCorePointApp(tenant));
  await agent.post("/login").type("form").send({ user: "teller1", pass: "training-only", returnTo: tenant.entryPath }).expect(302);
  return { agent, tenant };
}

describe("CorePoint legacy target", () => {
  it("supports the complete happy-path lookup and sub-account flow", async () => {
    const { agent, tenant } = await authenticatedAgent();
    const search = await agent.post("/workspace/search").type("form").send({ [tenant.memberField]: "4521" }).expect(200);
    expect(search.text).toContain("Alex Testman");

    const member = await agent.get("/workspace/member/4521").expect(200);
    expect(member.text).toContain("Regular Savings");
    expect(member.text).toContain("$2,481.13");

    const review = await agent.post("/workspace/member/4521/subaccount/review").type("form").send({ product: "Holiday Savings", nickname: "Gifts", opening_deposit: "25.00" }).expect(200);
    expect(review.text).toContain("Review New Sub-Account");

    const success = await agent.post("/workspace/member/4521/subaccount/submit").type("form").send({ product: "Holiday Savings", nickname: "Gifts", opening_deposit: "25.00" }).expect(200);
    expect(success.text).toContain("Account successfully opened");
  });

  it("exposes tenant B through a relabeled field, route, and reordered table", async () => {
    const { agent, tenant } = await authenticatedAgent(1);
    expect(tenant.entryPath).toBe("/operations");
    const searchPage = await agent.get("/workspace/search").expect(200);
    expect(searchPage.text).toContain("Acct Holder ID");
    expect(searchPage.text).toContain('name="f_ahid"');

    const member = await agent.get("/workspace/member/4521").expect(200);
    expect(member.text.indexOf("Product")).toBeLessThan(member.text.indexOf("Account No."));
  });

  it("returns expected not-found and permission-denied business states", async () => {
    const { agent, tenant } = await authenticatedAgent();
    const missing = await agent.post("/workspace/search").type("form").send({ [tenant.memberField]: "9999" }).expect(200);
    expect(missing.text).toContain("No member found");
    const denied = await agent.post("/workspace/search").type("form").send({ [tenant.memberField]: "7777" }).expect(200);
    expect(denied.text).toContain("Access denied — insufficient permissions");
  });

  it("injects session, supervisor, and application-error conditions deterministically", async () => {
    const { agent, tenant } = await authenticatedAgent();
    await agent.get(`/__chaos?flags=session_timeout,supervisor&redirect=${tenant.entryPath}`).expect(302);
    const search = await agent.get("/workspace/search").expect(200);
    expect(search.text).toContain("Session expiring");

    const override = await agent.post("/workspace/member/4521/subaccount/submit").type("form").send({ product: "Holiday Savings", opening_deposit: "25.00" }).expect(403);
    expect(override.text).toContain("Supervisor override required");

    await agent.get(`/__chaos?flags=error500&redirect=${tenant.entryPath}`).expect(302);
    const appError = await agent.post("/workspace/member/4521/subaccount/submit").type("form").send({ product: "Holiday Savings", opening_deposit: "25.00" }).expect(500);
    expect(appError.text).toContain("Unexpected Application Error");
  });

  it("injects a slow response and kills the live session", async () => {
    const { agent, tenant } = await authenticatedAgent();
    await agent.get(`/__chaos?flags=slow,session_kill&redirect=${tenant.entryPath}`).expect(302);
    const startedAt = Date.now();
    const response = await agent.post("/workspace/search").type("form").send({ [tenant.memberField]: "4521" }).expect(302);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_900);
    expect(response.headers.location).toBe("/login?reason=session_expired");
    await agent.get(tenant.entryPath).expect(302).expect("location", new RegExp("^/login"));
  });

  it("contains no test-specific selector attributes", async () => {
    const { agent } = await authenticatedAgent();
    const pages = await Promise.all([agent.get("/desk"), agent.get("/workspace/search"), agent.get("/workspace/member/4521")]);
    expect(pages.map((page) => page.text).join("\n")).not.toMatch(/data-testid|data-test=/);
  });
});
