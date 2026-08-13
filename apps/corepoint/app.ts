import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chaosSwitchboard, clearChaosFlag, getChaosFlags, slowResponses } from "./chaos.js";
import { members, type Member } from "./seed.js";
import type { TenantConfig } from "./tenants.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function safeReturnPath(value: unknown, fallback: string): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

function requireSession(tenant: TenantConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.cookies.cp_session !== `teller:${tenant.id}`) {
      response.redirect(`/login?returnTo=${encodeURIComponent(request.originalUrl)}`);
      return;
    }
    next();
  };
}

function renderWorkspace(response: Response, tenant: TenantConfig, view: string, data: Record<string, unknown>): void {
  response.render(view, { tenant, ...data });
}

export function createCorePointApp(tenant: TenantConfig) {
  const app = express();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(currentDirectory, "views"));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(express.static(path.join(currentDirectory, "public")));
  app.use(slowResponses);

  app.get("/health", (_request, response) => response.json({ ok: true, tenant: tenant.id }));
  app.get("/__chaos", chaosSwitchboard);

  app.get("/login", (request, response) => {
    response.render("login", {
      tenant,
      returnTo: safeReturnPath(request.query.returnTo, tenant.entryPath),
      error: request.query.error === "1"
    });
  });

  app.post("/login", (request, response) => {
    const expectedUser = process.env.COREPOINT_USERNAME ?? "teller1";
    const expectedPassword = process.env.COREPOINT_PASSWORD ?? "training-only";
    if (request.body.user !== expectedUser || request.body.pass !== expectedPassword) {
      response.redirect(`/login?error=1&returnTo=${encodeURIComponent(safeReturnPath(request.body.returnTo, tenant.entryPath))}`);
      return;
    }
    response.cookie("cp_session", `teller:${tenant.id}`, { httpOnly: true, sameSite: "lax" });
    response.redirect(safeReturnPath(request.body.returnTo, tenant.entryPath));
  });

  app.get([tenant.entryPath, tenant.id === "a" ? "/operations" : "/desk"], requireSession(tenant), (_request, response) => {
    response.render("desk", { tenant });
  });

  app.get("/workspace/search", requireSession(tenant), (request, response) => {
    const showTimeout = getChaosFlags(request).has("session_timeout");
    renderWorkspace(response, tenant, "search", { showTimeout });
  });

  app.post("/workspace/session/continue", requireSession(tenant), (request, response) => {
    clearChaosFlag(request, response, "session_timeout");
    response.redirect(safeReturnPath(request.body.returnTo, "/workspace/search"));
  });

  app.post("/workspace/search", requireSession(tenant), (request, response) => {
    const flags = getChaosFlags(request);
    if (flags.has("session_kill")) {
      response.clearCookie("cp_session");
      response.redirect("/login?reason=session_expired");
      return;
    }

    const memberId = String(request.body[tenant.memberField] ?? "").trim();
    if (memberId === "9999" || !members.has(memberId)) {
      renderWorkspace(response, tenant, "search-result", { memberId, member: undefined, denied: false });
      return;
    }

    const member = members.get(memberId);
    renderWorkspace(response, tenant, "search-result", {
      memberId,
      member,
      denied: member?.status === "Restricted"
    });
  });

  app.get("/workspace/member/:memberId", requireSession(tenant), (request, response) => {
    const memberId = String(request.params.memberId);
    const member = members.get(memberId);
    if (!member) {
      response.status(404);
      renderWorkspace(response, tenant, "not-found", { message: "Member record could not be loaded." });
      return;
    }
    if (member.status === "Restricted") {
      response.status(403);
      renderWorkspace(response, tenant, "denied", { memberId: member.id });
      return;
    }
    renderWorkspace(response, tenant, "member", { member });
  });

  app.get("/workspace/member/:memberId/subaccount/new", requireSession(tenant), (request, response) => {
    const memberId = String(request.params.memberId);
    const member = members.get(memberId);
    if (!member || member.status !== "Active") {
      response.status(member ? 403 : 404);
      renderWorkspace(response, tenant, member ? "denied" : "not-found", {
        memberId,
        message: "Member record could not be loaded."
      });
      return;
    }
    renderWorkspace(response, tenant, "subaccount-new", { member, errors: [], values: {} });
  });

  app.post("/workspace/member/:memberId/subaccount/review", requireSession(tenant), (request, response) => {
    const memberId = String(request.params.memberId);
    const member = members.get(memberId);
    if (!member || member.status !== "Active") {
      response.status(member ? 403 : 404);
      renderWorkspace(response, tenant, member ? "denied" : "not-found", {
        memberId,
        message: "Member record could not be loaded."
      });
      return;
    }
    const values = {
      product: String(request.body.product ?? ""),
      nickname: String(request.body.nickname ?? "").trim(),
      openingDeposit: String(request.body.opening_deposit ?? "").trim()
    };
    const errors = [
      ...(values.product ? [] : ["Select a sub-account type."]),
      ...(/^\d+(\.\d{2})?$/.test(values.openingDeposit) ? [] : ["Opening deposit must be a dollar amount."])
    ];
    if (errors.length > 0) {
      response.status(422);
      renderWorkspace(response, tenant, "subaccount-new", { member, errors, values });
      return;
    }
    renderWorkspace(response, tenant, "subaccount-review", { member, values, supervisorRequired: false });
  });

  app.post("/workspace/member/:memberId/subaccount/submit", requireSession(tenant), (request, response) => {
    const memberId = String(request.params.memberId);
    const member = members.get(memberId) as Member | undefined;
    if (!member || member.status !== "Active") {
      response.status(member ? 403 : 404);
      renderWorkspace(response, tenant, member ? "denied" : "not-found", {
        memberId,
        message: "Member record could not be loaded."
      });
      return;
    }
    const flags = getChaosFlags(request);
    if (flags.has("error500")) {
      response.status(500);
      renderWorkspace(response, tenant, "app-error", { reference: `ERR-${tenant.id.toUpperCase()}-500` });
      return;
    }
    const values = {
      product: String(request.body.product ?? "Holiday Savings"),
      nickname: String(request.body.nickname ?? ""),
      openingDeposit: String(request.body.opening_deposit ?? "0.00")
    };
    if (flags.has("supervisor") && request.body.override_code !== "2468") {
      response.status(403);
      renderWorkspace(response, tenant, "subaccount-review", { member, values, supervisorRequired: true });
      return;
    }
    const accountNumber = `S${String(member.accounts.length + 1).padStart(2, "0")}-${member.id}`;
    renderWorkspace(response, tenant, "subaccount-success", { member, values, accountNumber });
  });

  app.use((_request, response) => {
    response.status(404);
    renderWorkspace(response, tenant, "not-found", { message: "The requested CorePoint screen does not exist." });
  });

  return app;
}
