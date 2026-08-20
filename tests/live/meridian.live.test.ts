// Opt-in live tests against the hosted MERIDIAN app. They never run in the
// default suite (vitest excludes tests/live); `npm run test:meridian` opts in,
// and they self-skip without credentials in the environment.
//
// These are the token acceptance tests: MERIDIAN protects each form with a
// hidden per-session _token. The point is to prove our replay carries whatever
// token is live WITHOUT the token ever being recorded in an artifact or a log -
// the browser submits the real form, so the token is invisible to us.
import "dotenv/config";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCapability } from "../../src/run/runner.js";

const ORIGIN = "https://web-sample.interface-hiring.com";
const haveCreds = Boolean(process.env.MERIDIAN_OPERATOR && process.env.MERIDIAN_PASSWORD && process.env.MERIDIAN_BRANCH);

// Sign on with a fresh cookie jar and return that session's transaction token
// from a form page. Cookies are carried by hand because Node fetch does not.
async function sessionToken(): Promise<string> {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  const absorb = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (pair && eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  };
  absorb(await fetch(`${ORIGIN}/signon`, { headers: { cookie: cookieHeader() } }));
  const body = new URLSearchParams({ operator: process.env.MERIDIAN_OPERATOR!, password: process.env.MERIDIAN_PASSWORD!, branch: process.env.MERIDIAN_BRANCH! });
  const signon = await fetch(`${ORIGIN}/signon`, { method: "POST", headers: { cookie: cookieHeader(), "content-type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
  absorb(signon);
  const form = await fetch(`${ORIGIN}/members/103001/transfer`, { headers: { cookie: cookieHeader() } });
  const html = await form.text();
  return html.match(/name="_token"\s+value="([^"]*)"/)?.[1] ?? "";
}

describe.skipIf(!haveCreds)("MERIDIAN hidden-token acceptance (live)", () => {
  const roots: string[] = [];
  afterAll(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("issues a fresh per-session transaction token", async () => {
    const [a, b] = await Promise.all([sessionToken(), sessionToken()]);
    expect(a).not.toBe("");
    expect(b).not.toBe("");
    // Two independent sign-ons get two different tokens, so no token could ever
    // be hard-coded into a capability and still work.
    expect(a).not.toBe(b);
  });

  it("replays a token-bearing capability successfully with the token never in the artifact or log", async () => {
    const runRoot = await mkdtemp(path.join(os.tmpdir(), "meridian-live-"));
    roots.push(runRoot);
    // update_member_information submits a token-protected form and has no human
    // boundary. A fresh sign-on gives a fresh token; the browser submits it.
    const { result, runId } = await runCapability({
      reference: "update_member_information@1.0.0",
      params: { member_number: "103001", phone: "555-0181" },
      runId: "replay_livetoken", runRoot, headless: true, auth: "teller",
      policy: "policies/meridian.yaml"
    });
    expect(result.status).toBe("success");

    const artifact = await readFile("artifacts/update_member_information@1.0.0.json", "utf8");
    const log = await readFile(path.join(runRoot, runId, "log.jsonl"), "utf8");
    // The capability never records or logs the token field - the form carries it.
    expect(artifact).not.toContain("_token");
    expect(log).not.toContain("_token");
  });
});
