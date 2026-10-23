import { describe, expect, it } from "vitest";

import { createPasswordSignIn, hashAdminPassword, MIN_ADMIN_PASSWORD_LENGTH, parseAdminPasswordHash } from "./password-sign-in.ts";

const FAST = { N: 1024, r: 8, p: 1 };
const PASSWORD = "correct horse battery staple";

describe("admin password hashes", () => {
  it("round-trips a hash and checks the right password only", async () => {
    const hash = parseAdminPasswordHash(await hashAdminPassword(PASSWORD, FAST));
    expect(hash).not.toBeNull();
    const signIn = createPasswordSignIn({ hash });
    expect(signIn.enabled()).toBe(true);
    expect(await signIn.verify(PASSWORD)).toEqual({ ok: true });
    expect(await signIn.verify(`${PASSWORD} `)).toMatchObject({ ok: false, status: 401 });
  });

  it("salts every hash", async () => {
    expect(await hashAdminPassword(PASSWORD, FAST)).not.toBe(await hashAdminPassword(PASSWORD, FAST));
  });

  it(`refuses a password shorter than ${MIN_ADMIN_PASSWORD_LENGTH} characters`, async () => {
    await expect(hashAdminPassword("a".repeat(MIN_ADMIN_PASSWORD_LENGTH - 1), FAST)).rejects.toThrow(/at least/);
  });

  it.each([
    "", "plain", "scrypt$1024$8$1$c2FsdA==$a2V5", "scrypt$1000$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    `scrypt$${2 ** 20}$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`,
  ])("rejects a malformed or oversized hash: %j", (value) => {
    expect(parseAdminPasswordHash(value)).toBeNull();
  });

  it("is off without a hash", async () => {
    const signIn = createPasswordSignIn({ hash: null });
    expect(signIn.enabled()).toBe(false);
    expect(await signIn.verify(PASSWORD)).toMatchObject({ ok: false, status: 401 });
  });
});

describe("password attempts", () => {
  it("stops every address once the shared failure budget is spent, until the window passes", async () => {
    let now = 1_000_000;
    const hash = parseAdminPasswordHash(await hashAdminPassword(PASSWORD, FAST));
    const signIn = createPasswordSignIn({ hash, now: () => now, globalFailures: { limit: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++) expect(await signIn.verify("wrong password!")).toMatchObject({ status: 401 });
    expect(await signIn.verify(PASSWORD)).toMatchObject({ ok: false, status: 429, retryAfterMs: 60_000 });
    now += 60_001;
    expect(await signIn.verify(PASSWORD)).toEqual({ ok: true });
  });

  it("checks one password at a time", async () => {
    const hash = parseAdminPasswordHash(await hashAdminPassword(PASSWORD, FAST));
    const signIn = createPasswordSignIn({ hash });
    const [first, second] = await Promise.all([signIn.verify(PASSWORD), signIn.verify(PASSWORD)]);
    expect(first).toEqual({ ok: true });
    expect(second).toMatchObject({ ok: false, status: 429 });
  });

  it("does not hash an oversized password", async () => {
    const hash = parseAdminPasswordHash(await hashAdminPassword(PASSWORD, FAST));
    expect(await createPasswordSignIn({ hash }).verify("x".repeat(2048))).toMatchObject({ ok: false, status: 401 });
  });
});
