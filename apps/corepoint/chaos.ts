import type { NextFunction, Request, Response } from "express";

export type ChaosFlag = "slow" | "session_timeout" | "session_kill" | "supervisor" | "error500";

const knownFlags = new Set<ChaosFlag>(["slow", "session_timeout", "session_kill", "supervisor", "error500"]);

export function getChaosFlags(request: Request): Set<ChaosFlag> {
  const raw = typeof request.cookies?.cp_chaos === "string" ? request.cookies.cp_chaos : "";
  return new Set(
    raw
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string): value is ChaosFlag => knownFlags.has(value as ChaosFlag))
  );
}

export async function slowResponses(request: Request, _response: Response, next: NextFunction): Promise<void> {
  if (getChaosFlags(request).has("slow") && request.path.startsWith("/workspace")) {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  next();
}

export function chaosSwitchboard(request: Request, response: Response): void {
  const flags = typeof request.query.flags === "string" ? request.query.flags : "";
  const valid = flags
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is ChaosFlag => knownFlags.has(value as ChaosFlag));
  response.cookie("cp_chaos", valid.join(","), { httpOnly: true, sameSite: "lax" });
  const redirect = typeof request.query.redirect === "string" && request.query.redirect.startsWith("/")
    ? request.query.redirect
    : "/login";
  response.redirect(redirect);
}

export function clearChaosFlag(request: Request, response: Response, flag: ChaosFlag): void {
  const remaining = [...getChaosFlags(request)].filter((candidate) => candidate !== flag);
  response.cookie("cp_chaos", remaining.join(","), { httpOnly: true, sameSite: "lax" });
}
