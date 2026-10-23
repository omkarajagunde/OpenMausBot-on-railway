// The Railway image's entry point: a root supervisor of two `maus` children, the server on 127.0.0.1:8799 and the Caddy
// edge on Railway's $PORT, the only listener the network reaches. The edge always forwards X-Forwarded-*, so no remote
// request gets loopback trust, and loopback itself is `service` trust: a bot's shell is a loopback caller too.
// The administrator password never reaches the server: it gets a scrypt hash, over an inherited pipe.
import { spawn, type ChildProcess } from "node:child_process";
import { chownSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLOUD_SECRETS_FD_ENV } from "./cloud-secrets.ts";
import { OOM_SCORE, spawnWithOomScore } from "./oom-score.ts";
import { ADMIN_PASSWORD_HASH_ENV, hashAdminPassword, MIN_ADMIN_PASSWORD_LENGTH, parseAdminPasswordHash } from "./password-sign-in.ts";
import { restartPolicy } from "./restart.ts";
import { codeTrustProblem, passwdIds, SECRETS_FD, spawnWithSecrets } from "./root-launcher.ts";

const SERVICE_USER = "maus";
export const ADMIN_PASSWORD_ENV = "OMB_ADMIN_PASSWORD";

/** Names the server never gets: the password, and the settings this entrypoint decides. */
const WITHHELD = new Set([ADMIN_PASSWORD_ENV, ADMIN_PASSWORD_HASH_ENV, "OMB_LOOPBACK_TRUST", "OMB_DEV_TRUST_LOCAL_BROWSER", CLOUD_SECRETS_FD_ENV]);

export function railwayPublicOrigin(env: NodeJS.ProcessEnv): string | null {
  const configured = env.OMB_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const domain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  return domain && /^[a-z0-9.-]+$/i.test(domain) ? `https://${domain}` : null;
}

/** The hash the server checks: OMB_ADMIN_PASSWORD_HASH as given, else OMB_ADMIN_PASSWORD hashed here. */
export async function adminPasswordHash(env: NodeJS.ProcessEnv): Promise<string> {
  const given = env[ADMIN_PASSWORD_HASH_ENV]?.trim();
  if (given) {
    if (!parseAdminPasswordHash(given)) throw new Error(`${ADMIN_PASSWORD_HASH_ENV} is not a valid scrypt hash; generate one with: node dist-server/railway-start.js hash`);
    return given;
  }
  const password = env[ADMIN_PASSWORD_ENV];
  if (!password) {
    throw new Error(`Set ${ADMIN_PASSWORD_ENV} (at least ${MIN_ADMIN_PASSWORD_LENGTH} characters) in the service's variables: it is how you sign in to this server.`);
  }
  return hashAdminPassword(password);
}

export function railwayChildEnvironments(env: NodeJS.ProcessEnv, home: string) {
  const origin = railwayPublicOrigin(env);
  const kept = Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && !WITHHELD.has(name)));
  const server: NodeJS.ProcessEnv = {
    ...kept,
    HOME: home,
    OMB_DATA_DIR: env.OMB_DATA_DIR || posix.join(home, ".openmausbot"),
    OMB_PORT: "8799",
    OMB_WEBHOOK_PORT: "8800",
    OMB_LOOPBACK_TRUST: "service",
    // The sign-in page names the server; a container's hostname is a random id.
    OMB_ENVIRONMENT_LABEL: env.OMB_ENVIRONMENT_LABEL?.trim() || "OpenMausBot",
    [CLOUD_SECRETS_FD_ENV]: String(SECRETS_FD),
    ...(origin ? { OMB_PUBLIC_URL: origin, OMB_WEBHOOK_PUBLIC_URL: env.OMB_WEBHOOK_PUBLIC_URL || origin } : {}),
  };
  const edge: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/omb-edge", XDG_DATA_HOME: "/tmp/omb-edge/data", XDG_CONFIG_HOME: "/tmp/omb-edge/config",
    PORT: /^\d{1,5}$/.test(env.PORT ?? "") ? env.PORT : "8080",
    OMB_EDGE_SCHEME: env.OMB_EDGE_SCHEME === "http" ? "http" : "https",
  };
  return { server, edge };
}

/** Railway keeps the data only on a volume; without one every deploy starts empty. */
export function mountedAt(path: string, mountinfo: string): boolean {
  return mountinfo.split("\n").some((line) => line.split(" ")[4] === path);
}

export async function startRailway(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  process.umask(0o077);
  const home = env.HOME || "/data";
  const hash = await adminPasswordHash(env);
  try {
    if (!mountedAt(home, readFileSync("/proc/self/mountinfo", "utf8"))) {
      console.warn(`railway: no volume is mounted at ${home}; sign-ins, bots and chats are lost on every deploy. Attach a volume at ${home}.`);
    }
  } catch { /* not Linux */ }
  let ids: { uid: number; gid: number } | null = null;
  if (process.getuid?.() === 0) {
    ids = passwdIds(readFileSync("/etc/passwd", "utf8"), SERVICE_USER);
    if (!ids) throw new Error(`The ${SERVICE_USER} user is missing from this image.`);
    // Railway mounts a new volume as root's; only the mount point changes owner, anything inside keeps its owner.
    const stat = statSync(home);
    if (stat.uid !== ids.uid || stat.gid !== ids.gid) chownSync(home, ids.uid, ids.gid);
    process.setgroups?.([]);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const edgeBin = env.OMB_EDGE_BIN || "/usr/local/bin/caddy";
  const edgeConfig = env.OMB_EDGE_CONFIG || "/app/railway/Caddyfile";
  if (ids) {
    const problem = codeTrustProblem([process.execPath, fileURLToPath(import.meta.url), join(here, "index.js"), edgeBin, edgeConfig], home);
    if (problem) throw new Error(`This image's code is not safe to run as root: ${problem}. Rebuild it from the repository's Dockerfile.`);
  }
  const { server, edge } = railwayChildEnvironments(env, home);
  const secrets = { [ADMIN_PASSWORD_HASH_ENV]: hash };
  const children: ChildProcess[] = [];
  let stopping = false;
  const stop = (failed: boolean) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = failed ? 1 : 0;
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); }, 20_000);
    force.unref();
  };
  const watch = (child: ChildProcess, again?: (code: number | null) => boolean) => {
    children.push(child);
    child.once("error", () => stop(true));
    child.once("exit", (code) => {
      children.splice(children.indexOf(child), 1);
      if (!again?.(code)) stop(true);
    });
  };
  const policy = restartPolicy();
  const runServer = () => {
    watch(spawnWithOomScore(OOM_SCORE.server, () => spawnWithSecrets(process.execPath, [join(here, "index.js")], server, secrets, ids)), (code) => {
      if (!policy.again(code, stopping)) return false;
      runServer();
      return true;
    });
  };
  runServer();
  watch(spawnWithOomScore(OOM_SCORE.edge, () => spawn(edgeBin, ["run", "--config", edgeConfig, "--adapter", "caddyfile"],
    { env: edge, stdio: "inherit", ...(ids ? { uid: ids.uid, gid: ids.gid } : {}) })));
  process.once("SIGTERM", () => stop(false));
  process.once("SIGINT", () => stop(false));
}

async function printHash(): Promise<void> {
  let password = "";
  for await (const chunk of process.stdin) password += chunk;
  console.log(await hashAdminPassword(password.replace(/\r?\n$/, "")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const run = process.argv[2] === "hash" ? printHash() : startRailway();
  run.catch((error: unknown) => {
    console.error(`railway: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
