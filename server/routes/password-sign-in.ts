// POST /api/auth/password: the owner's administrator password opens a browser session. It runs before the session gate:
// the password is the credential. Never log the body.
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readBody } from "../harness/http.ts";
import type { PasswordSignIn } from "../password-sign-in.ts";
import { labelFromUserAgent, provesSameOrigin, requestOrigin, requestSource, serializeSessionCookie } from "../request-auth.ts";
import { cookieMaxAgeSeconds, type SessionRegistry } from "../sessions.ts";

export const PASSWORD_SIGN_IN_PATH = "/api/auth/password";

export interface PasswordSignInRequest { req: IncomingMessage; res: ServerResponse; path: string; method: string }

export function createPasswordSignInRoute(deps: {
  passwords: PasswordSignIn;
  sessions: Pick<SessionRegistry, "attemptAllowed" | "noteFailure" | "clearFailures" | "issue">;
  cookieName: string;
}): (request: PasswordSignInRequest) => Promise<boolean> {
  return async ({ req, res, path, method }) => {
    if (method !== "POST" || path !== PASSWORD_SIGN_IN_PATH) return false;
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      json(res, 415, { error: "send the password as JSON (content-type: application/json)" });
      return true;
    }
    if (!deps.passwords.enabled()) {
      json(res, 404, { error: "password sign-in is not set up on this server" });
      return true;
    }
    if (!provesSameOrigin(req)) {
      json(res, 403, { error: "forbidden: sign in from this server's own page" });
      return true;
    }
    const source = requestSource(req);
    const allowed = deps.sessions.attemptAllowed(source);
    if (!allowed.ok) {
      json(res, 429, { error: `too many failed sign-in attempts from your address; try again in ${Math.ceil(allowed.retryAfterMs / 1000)}s` });
      return true;
    }
    const body = await readBody(req, 4096);
    const password = typeof body?.password === "string" ? body.password : "";
    const label = typeof body?.label === "string" ? body.label : "";
    const verdict = await deps.passwords.verify(password);
    if (!verdict.ok) {
      if (verdict.status === 401) deps.sessions.noteFailure(source);
      console.warn(`password sign-in refused from ${source}`);
      json(res, verdict.status, { error: verdict.error });
      return true;
    }
    deps.sessions.clearFailures(source);
    const issued = deps.sessions.issue({ label: label.trim() || labelFromUserAgent(req.headers["user-agent"]), scopes: ["admin", "client"], cookieOnly: true });
    const secure = requestOrigin(req)?.startsWith("https://") === true;
    res.setHeader("set-cookie", serializeSessionCookie(deps.cookieName, issued.token, { secure, maxAgeSeconds: cookieMaxAgeSeconds(issued.session) }));
    json(res, 200, { session: issued.session });
    return true;
  };
}
