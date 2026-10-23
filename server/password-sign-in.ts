// Owner sign-in with one administrator password, for a server reached only through a hosting edge (Railway).
// The server holds only a scrypt hash; the plaintext stays with the entrypoint that hashed it.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const MIN_ADMIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;
export const ADMIN_PASSWORD_HASH_ENV = "OMB_ADMIN_PASSWORD_HASH";

const KEY_LENGTH = 32;
const DEFAULT_COST = { N: 2 ** 15, r: 8, p: 1 } as const;
/** Bounds what a configured hash can make scrypt allocate: 128 · N · r bytes. */
const MAX_MEMORY = 64 * 1024 * 1024;
const HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, { ...options, maxmem: MAX_MEMORY }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export interface AdminPasswordHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

/** `scrypt$N$r$p$salt$key`, base64 parts. */
export async function hashAdminPassword(password: string, cost: { N: number; r: number; p: number } = DEFAULT_COST): Promise<string> {
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`The admin password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`);
  }
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function parseAdminPasswordHash(value: string | undefined): AdminPasswordHash | null {
  const match = HASH_PATTERN.exec(value?.trim() ?? "");
  if (!match) return null;
  const [N, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const powerOfTwo = N > 1 && (N & (N - 1)) === 0;
  if (!powerOfTwo || r < 1 || p < 1 || 128 * N * r > MAX_MEMORY || p > 16) return null;
  const salt = Buffer.from(match[4], "base64");
  const key = Buffer.from(match[5], "base64");
  if (salt.length < 16 || key.length !== KEY_LENGTH) return null;
  return { N, r, p, salt, key };
}

export type PasswordVerdict =
  | { ok: true }
  | { ok: false; status: 401; error: string }
  | { ok: false; status: 429; error: string; retryAfterMs: number };

export interface PasswordSignIn {
  enabled(): boolean;
  verify(password: string): Promise<PasswordVerdict>;
}

export interface PasswordSignInOptions {
  hash: AdminPasswordHash | null;
  now?: () => number;
  /** Failures from every address together; a forged client address cannot get past it. */
  globalFailures?: { limit: number; windowMs: number };
}

const WRONG = "That password is not right.";

export function createPasswordSignIn(options: PasswordSignInOptions): PasswordSignIn {
  const now = options.now ?? Date.now;
  const budget = options.globalFailures ?? { limit: 30, windowMs: 10 * 60_000 };
  const failures: number[] = [];
  let checking = false;
  const busy = (retryAfterMs: number): PasswordVerdict => ({
    ok: false, status: 429, retryAfterMs,
    error: `Too many sign-in attempts. Try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`,
  });
  return {
    enabled: () => options.hash !== null,
    async verify(password) {
      const hash = options.hash;
      if (!hash) return { ok: false, status: 401, error: "Password sign-in is not set up on this server." };
      if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, status: 401, error: WRONG };
      const at = now();
      while (failures.length && failures[0]! <= at - budget.windowMs) failures.shift();
      if (failures.length >= budget.limit) return busy(failures[0]! + budget.windowMs - at);
      // One scrypt at a time: each holds tens of megabytes.
      if (checking) return busy(1_000);
      checking = true;
      try {
        const candidate = await scrypt(password, hash.salt, hash.key.length, { N: hash.N, r: hash.r, p: hash.p });
        if (timingSafeEqual(candidate, hash.key)) return { ok: true };
        failures.push(now());
        return { ok: false, status: 401, error: WRONG };
      } finally {
        checking = false;
      }
    },
  };
}

/** From the server's boot environment (the launcher's pipe, then its own). Neither the hash nor a plaintext password stays
 * in `env`: every engine and tool the server starts inherits it. */
export function passwordSignInFromBoot(boot: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv = process.env): PasswordSignIn {
  const given = boot[ADMIN_PASSWORD_HASH_ENV];
  delete env[ADMIN_PASSWORD_HASH_ENV];
  if (env.OMB_ADMIN_PASSWORD !== undefined) {
    delete env.OMB_ADMIN_PASSWORD;
    console.warn(`OMB_ADMIN_PASSWORD is ignored by the server; give it ${ADMIN_PASSWORD_HASH_ENV} (the Railway entrypoint hashes the password for it)`);
  }
  const signIn = createPasswordSignIn({ hash: parseAdminPasswordHash(given) });
  if (given !== undefined && !signIn.enabled()) {
    throw new Error(`${ADMIN_PASSWORD_HASH_ENV} is not a valid scrypt hash; generate one with: node dist-server/railway-start.js hash`);
  }
  return signIn;
}
