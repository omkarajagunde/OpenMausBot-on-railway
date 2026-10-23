// A real server reached as the Railway image's edge reaches it, the owner signing in with the administrator password.
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { hashAdminPassword } from "./password-sign-in.ts";

const PASSWORD = "a long enough password";
const PUBLIC = "https://omb.example.test";

function raw(url: string, path: string, headers: Record<string, string>, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const target = new URL(path, url);
    const call = request({ hostname: target.hostname, port: target.port, path: target.pathname, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    call.on("error", reject);
    call.end(body);
  });
}

/** What the Caddy edge hands the server for a browser on the public address. */
const viaEdge = (extra: Record<string, string> = {}) => ({
  host: "omb.example.test", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7",
  origin: PUBLIC, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", ...extra,
});
const json = { "content-type": "application/json" };

let fixture: VerificationServer;
let url: string;

beforeAll(async () => {
  const hash = await hashAdminPassword(PASSWORD, { N: 1024, r: 8, p: 1 });
  fixture = await launchVerificationServer({ OMB_DEV_TRUST_LOCAL_BROWSER: "0", OMB_ADMIN_PASSWORD_HASH: hash });
  url = fixture.info.url;
}, 60_000);
afterAll(async () => { await fixture?.close(); });

describe("the administrator password", () => {
  it("is offered on the sign-in page", async () => {
    const environment = JSON.parse((await raw(url, "/.well-known/openmausbot/environment", viaEdge())).body);
    expect(environment.capabilities.passwordSignIn).toBe(true);
  });

  it("keeps everything else behind a sign-in", async () => {
    for (const path of ["/api/bots", "/api/config", "/api/instances"]) {
      expect([401, 403], path).toContain((await raw(url, path, viaEdge())).status);
    }
  });

  it("refuses a wrong password, and one sent from another page", async () => {
    const wrong = await raw(url, "/api/auth/password", viaEdge(json), "POST", JSON.stringify({ password: "not the password" }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    const elsewhere = await raw(url, "/api/auth/password", viaEdge({ ...json, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }), "POST", JSON.stringify({ password: PASSWORD }));
    expect(elsewhere.status).toBe(403);
  });

  it("signs the owner in with a secure, browser-only cookie that has admin rights", async () => {
    const signedIn = await raw(url, "/api/auth/password", viaEdge(json), "POST", JSON.stringify({ password: PASSWORD, label: "Laptop" }));
    expect(signedIn.status).toBe(200);
    const header = String(signedIn.headers["set-cookie"]);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/Secure/);
    expect(header).toMatch(/SameSite=Lax/);
    const cookie = header.split(";", 1)[0]!;
    const session = JSON.parse((await raw(url, "/api/auth/session", viaEdge({ cookie }))).body);
    expect(session).toMatchObject({ kind: "session", label: "Laptop", scopes: ["admin", "client"] });
    expect((await raw(url, "/api/config", viaEdge({ cookie }))).status).toBe(200);
    // The cookie's token is no bearer token, and it works only from this server's own page.
    const token = cookie.split("=", 2)[1]!;
    expect((await raw(url, "/api/bots", viaEdge({ authorization: `Bearer ${token}` }))).status).toBe(401);
    expect((await raw(url, "/api/bots", viaEdge({ cookie, origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });
});
