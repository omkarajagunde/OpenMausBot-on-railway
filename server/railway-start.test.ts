import { describe, expect, it } from "vitest";

import { CLOUD_SECRETS_FD_ENV } from "./cloud-secrets.ts";
import { ADMIN_PASSWORD_HASH_ENV, hashAdminPassword } from "./password-sign-in.ts";
import { ADMIN_PASSWORD_ENV, adminPasswordHash, mountedAt, railwayChildEnvironments, railwayPublicOrigin } from "./railway-start.ts";

describe("the public origin", () => {
  it("prefers OMB_PUBLIC_URL, then Railway's public domain", () => {
    expect(railwayPublicOrigin({ OMB_PUBLIC_URL: "https://bots.example.test/", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" })).toBe("https://bots.example.test");
    expect(railwayPublicOrigin({ RAILWAY_PUBLIC_DOMAIN: "omb-production.up.railway.app" })).toBe("https://omb-production.up.railway.app");
    expect(railwayPublicOrigin({ RAILWAY_PUBLIC_DOMAIN: "evil.test/path?x" })).toBeNull();
    expect(railwayPublicOrigin({})).toBeNull();
  });
});

describe("the administrator password", () => {
  it("is required", async () => {
    await expect(adminPasswordHash({})).rejects.toThrow(ADMIN_PASSWORD_ENV);
  });

  it("is hashed, or taken as a ready hash", async () => {
    expect(await adminPasswordHash({ [ADMIN_PASSWORD_ENV]: "a long enough password" })).toMatch(/^scrypt\$/);
    const ready = await hashAdminPassword("a long enough password", { N: 1024, r: 8, p: 1 });
    expect(await adminPasswordHash({ [ADMIN_PASSWORD_HASH_ENV]: ready, [ADMIN_PASSWORD_ENV]: "ignored" })).toBe(ready);
    await expect(adminPasswordHash({ [ADMIN_PASSWORD_HASH_ENV]: "not a hash" })).rejects.toThrow(/not a valid scrypt hash/);
  });

  it("refuses a short one", async () => {
    await expect(adminPasswordHash({ [ADMIN_PASSWORD_ENV]: "short" })).rejects.toThrow(/at least/);
  });
});

describe("the children's environments", () => {
  const env = {
    PATH: "/usr/bin", PORT: "7123", RAILWAY_PUBLIC_DOMAIN: "omb.up.railway.app", ANTHROPIC_API_KEY: "kept-for-the-server",
    [ADMIN_PASSWORD_ENV]: "a long enough password", [ADMIN_PASSWORD_HASH_ENV]: "scrypt$...", OMB_LOOPBACK_TRUST: "owner",
    OMB_DEV_TRUST_LOCAL_BROWSER: "1",
  };
  const { server, edge } = railwayChildEnvironments(env, "/data");

  it("never hands the server the password or its hash", () => {
    expect(JSON.stringify(server)).not.toContain("a long enough password");
    expect(server[ADMIN_PASSWORD_HASH_ENV]).toBeUndefined();
    expect(server[CLOUD_SECRETS_FD_ENV]).toBe("3");
  });

  it("makes loopback a service, whatever the variables say", () => {
    expect(server.OMB_LOOPBACK_TRUST).toBe("service");
    expect(server.OMB_DEV_TRUST_LOCAL_BROWSER).toBeUndefined();
  });

  it("sets the server's home, ports and public address", () => {
    expect(server).toMatchObject({
      HOME: "/data", OMB_DATA_DIR: "/data/.openmausbot", OMB_PORT: "8799", OMB_WEBHOOK_PORT: "8800",
      OMB_PUBLIC_URL: "https://omb.up.railway.app", OMB_WEBHOOK_PUBLIC_URL: "https://omb.up.railway.app",
      ANTHROPIC_API_KEY: "kept-for-the-server", OMB_ENVIRONMENT_LABEL: "OpenMausBot",
    });
    expect(railwayChildEnvironments({ OMB_ENVIRONMENT_LABEL: "Team bots" }, "/data").server.OMB_ENVIRONMENT_LABEL).toBe("Team bots");
  });

  it("gives the edge only its port and paths", () => {
    expect(edge.PORT).toBe("7123");
    expect(Object.keys(edge).sort()).toEqual(["HOME", "OMB_EDGE_SCHEME", "PATH", "PORT", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]);
    expect(edge.OMB_EDGE_SCHEME).toBe("https");
    expect(railwayChildEnvironments({ OMB_EDGE_SCHEME: "http" }, "/data").edge.OMB_EDGE_SCHEME).toBe("http");
    expect(railwayChildEnvironments({ OMB_EDGE_SCHEME: "gopher" }, "/data").edge.OMB_EDGE_SCHEME).toBe("https");
    expect(railwayChildEnvironments({ PORT: "80; rm -rf /" }, "/data").edge.PORT).toBe("8080");
  });
});

describe("the data volume check", () => {
  const mountinfo = [
    "22 1 0:21 / / rw,relatime - overlay overlay rw",
    "35 22 8:1 / /data rw,relatime - ext4 /dev/sda1 rw",
  ].join("\n");
  it("finds a mount by its mount point", () => {
    expect(mountedAt("/data", mountinfo)).toBe(true);
    expect(mountedAt("/srv", mountinfo)).toBe(false);
  });
});
