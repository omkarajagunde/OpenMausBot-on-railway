import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, loadConfig, PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV, type AppConfig } from "./config.ts";
import { acquireDataDirLease } from "./data-dir-lease.ts";
import { SetupCancelled, type SetupIo } from "./cli-prompts.ts";
import { isSetupComplete, readCliStartup, runSetup, saveCliStartup } from "./cli-setup.ts";

const options = { dataDir: DATA_DIR, port: 8799 };
const configPath = join(DATA_DIR, "config.json");
const models = {
  default: "fixture-default",
  options: [
    { id: "fixture-default", label: "Fixture default" },
    { id: "fixture-selected", label: "Fixture selected" },
  ],
};
type Dependencies = NonNullable<Parameters<typeof runSetup>[2]>;

function dependencies() {
  return {
    inspect: vi.fn<Dependencies["inspect"]>().mockResolvedValue({
      snapshot: { state: "available", authenticated: true }, models,
    }),
    runCli: vi.fn<Dependencies["runCli"]>().mockResolvedValue(undefined),
  };
}

function prompts(script: { choices?: Array<number | Error>; confirms?: boolean[]; secrets?: Array<string | Error>; answers?: string[] } = {}) {
  const choices = [...(script.choices ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const answers = [...(script.answers ?? [])];
  const lines: string[] = [];
  const take = <T>(values: T[], question: string): T => {
    if (!values.length) throw new Error(`Unexpected fixture prompt: ${question}`);
    return values.shift()!;
  };
  const io = {
    log: vi.fn((line: string) => { lines.push(line); }),
    choose: vi.fn<SetupIo["choose"]>(async (question, available) => {
      lines.push(question, ...available);
      const selected = take(choices, question);
      if (selected instanceof Error) throw selected;
      if (selected < 0 || selected >= available.length) throw new Error("Fixture selected an unavailable option");
      return selected;
    }),
    confirm: vi.fn<SetupIo["confirm"]>(async (question) => { lines.push(question); return take(confirms, question); }),
    secret: vi.fn<SetupIo["secret"]>(async (question) => {
      lines.push(question);
      const value = take(secrets, question);
      if (value instanceof Error) throw value;
      return value;
    }),
    ask: vi.fn<SetupIo["ask"]>(async (question) => { lines.push(question); return take(answers, question); }),
  };
  return { io, lines, assertConsumed: () => expect([choices, confirms, secrets, answers]).toEqual([[], [], [], []]) };
}

function persist(config: AppConfig & Record<string, unknown>): string {
  const raw = JSON.stringify(config, null, 2);
  writeFileSync(configPath, raw, { mode: 0o600 });
  return raw;
}

function expectLeaseReleased() {
  const lease = acquireDataDirLease(DATA_DIR);
  expect(lease.release()).toBe(true);
}

beforeEach(() => {
  // testing/setup.ts assigns a throwaway HOME before this module loads.
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  for (const name of [...WORKSPACE_CREDENTIAL_ENV, ...PROVIDER_CREDENTIAL_ENV, "OPENAI_COMPAT_MODEL", "OPENAI_COMPAT_PROVIDER"])
    vi.stubEnv(name, undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Wizard fixtures must never make network requests"); }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Claude onboarding", () => {
  it("uses an existing Claude login and saves the selected model without starting an auth process", async () => {
    const deps = dependencies();
    const ui = prompts({ choices: [0, 1], confirms: [true] });
    expect(await runSetup(options, ui.io, deps)).toBe(true);
    expect(deps.inspect).toHaveBeenCalledWith("claude", { driver: "claudeAgent", enabled: true });
    expect(deps.runCli).not.toHaveBeenCalled();
    expect(ui.io.choose.mock.calls[1]?.[1]).toEqual(["Fixture default", "Fixture selected", "Search models…"]);
    expect(loadConfig().defaultModelSelection).toEqual({ instanceId: "claude", model: "fixture-selected" });
    expect(loadConfig().instances?.claude).toEqual({ driver: "claudeAgent", enabled: true });
    expect(ui.lines.join("\n")).toContain("Existing sign-in found");
    expect(await isSetupComplete(DATA_DIR)).toBe(true);
    ui.assertConsumed();
    expectLeaseReleased();
  });

  it("installs Claude Code only after confirmation, then runs its account login", async () => {
    const deps = dependencies();
    deps.inspect
      .mockResolvedValueOnce({ snapshot: { state: "unavailable", reason: "missing fixture CLI" }, models })
      .mockResolvedValueOnce({ snapshot: { state: "available", authenticated: false }, models });
    const ui = prompts({ choices: [0, 0], confirms: [true, true] });
    expect(await runSetup(options, ui.io, deps)).toBe(true);
    expect(deps.runCli.mock.calls).toEqual([
      ["npm", ["install", "-g", "@anthropic-ai/claude-code"]],
      ["claude", ["auth", "login"], undefined],
    ]);
    expect(ui.io.confirm.mock.invocationCallOrder[0]).toBeLessThan(deps.runCli.mock.invocationCallOrder[0]!);
    expect(deps.inspect).toHaveBeenCalledTimes(3);
    ui.assertConsumed();
  });

  it("runs Claude's account login and retains a custom CLI path and environment", async () => {
    const original = { driver: "claudeAgent", config: { cli: "/fixture/bin/claude" }, environment: { CLAUDE_CONFIG_DIR: "/fixture/account" } };
    persist({ instances: { workClaude: original } });
    const deps = dependencies();
    deps.inspect.mockResolvedValueOnce({ snapshot: { state: "available", authenticated: false }, models });
    const ui = prompts({ choices: [1, 0], confirms: [true] });
    expect(await runSetup(options, ui.io, deps)).toBe(true);
    expect(deps.runCli).toHaveBeenCalledWith("/fixture/bin/claude", ["auth", "login"], original.environment);
    expect(loadConfig().instances?.workClaude).toEqual({ ...original, enabled: true });
    expect(loadConfig().defaultModelSelection?.instanceId).toBe("workClaude");
    ui.assertConsumed();
  });

  it("does not save after a CLI exits successfully without confirming sign-in", async () => {
    const original = persist({ profile: { name: "Existing user" } });
    const deps = dependencies();
    deps.inspect.mockResolvedValue({ snapshot: { state: "available", authenticated: false }, models });
    const ui = prompts({ choices: [0, 2] });
    expect(await runSetup(options, ui.io, deps)).toBe(false);
    expect(ui.lines.join("\n")).toContain("Sign-in was not confirmed");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expectLeaseReleased();
  });

  it("keeps settings after sign-in cancellation", async () => {
    const original = persist({ profile: { name: "Existing user" } });
    const deps = dependencies();
    deps.inspect.mockResolvedValueOnce({ snapshot: { state: "available", authenticated: false }, models });
    deps.runCli.mockRejectedValue(new SetupCancelled());
    const ui = prompts({ choices: [0] });
    expect(await runSetup(options, ui.io, deps)).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expectLeaseReleased();
  });

  it("cancels a declined install before running any command", async () => {
    const deps = dependencies();
    deps.inspect.mockResolvedValue({ snapshot: { state: "unavailable" }, models });
    const ui = prompts({ choices: [0], confirms: [false] });
    expect(await runSetup(options, ui.io, deps)).toBe(false);
    expect(deps.runCli).not.toHaveBeenCalled();
    expect(existsSync(configPath)).toBe(false);
    expectLeaseReleased();
  });

  it("keeps the saved model selected when setup is run again", async () => {
    persist({ instances: { claude: { driver: "claudeAgent" } }, defaultModelSelection: { instanceId: "claude", model: "fixture-selected" } });
    const ui = prompts({ choices: [1, 0], confirms: [true] });
    expect(await runSetup(options, ui.io, dependencies())).toBe(true);
    expect(ui.io.choose.mock.calls[0]?.[2]).toBe(1);
    expect(ui.io.choose.mock.calls[1]?.[2]).toBe(0);
    expect(ui.io.choose.mock.calls[1]?.[1][0]).toBe("Fixture selected");
    expect(loadConfig().defaultModelSelection).toEqual({ instanceId: "claude", model: "fixture-selected" });
  });

  it("uses the model ID when the catalog has no human-readable name", async () => {
    const deps = dependencies();
    deps.inspect.mockResolvedValue({
      snapshot: { state: "available", authenticated: true },
      models: { default: "id-only", options: [{ id: "id-only", label: "id-only" }, { id: "unnamed", label: " " }] },
    });
    const ui = prompts({ choices: [0, 1], confirms: [true] });
    expect(await runSetup(options, ui.io, deps)).toBe(true);
    expect(ui.io.choose.mock.calls[1]?.[1]).toEqual(["id-only", "unnamed", "Search models…"]);
    expect(loadConfig().defaultModelSelection?.model).toBe("unnamed");
    ui.assertConsumed();
  });

  it("does not change a saved setup when the final save is declined", async () => {
    const original = persist({ profile: { name: "Keep" }, defaultModelSelection: { instanceId: "claude", model: "previous" } });
    const ui = prompts({ choices: [0, 1], confirms: [false] });
    expect(await runSetup(options, ui.io, dependencies())).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expectLeaseReleased();
  });

  it("does not install over an unavailable custom CLI path", async () => {
    const original = persist({ instances: { claude: { driver: "claudeAgent", config: { cli: "/fixture/custom-claude" } } } });
    const deps = dependencies();
    deps.inspect.mockResolvedValue({ snapshot: { state: "unavailable" }, models });
    const ui = prompts({ choices: [0, 2] });
    expect(await runSetup(options, ui.io, deps)).toBe(false);
    expect(ui.lines.join("\n")).toContain("custom CLI path is unavailable");
    expect(deps.runCli).not.toHaveBeenCalled();
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expectLeaseReleased();
  });

  it("does not overwrite an instance that repurposed the claude ID for another engine", async () => {
    const existing = { driver: "customAcp", displayName: "Keep this connection", config: { cli: "/fixture/other" } };
    persist({ instances: { claude: existing } });
    const ui = prompts({ choices: [0, 0], confirms: [true] });
    expect(await runSetup(options, ui.io, dependencies())).toBe(true);
    const saved = loadConfig();
    expect(saved.instances?.claude).toEqual(existing);
    expect(saved.defaultModelSelection?.instanceId).toMatch(/^claude-[\da-z]+$/);
    expect(saved.instances?.[saved.defaultModelSelection!.instanceId]?.driver).toBe("claudeAgent");
  });
});

describe("connection recovery", () => {
  it("retries a connection without changing the saved setup during the failed attempt", async () => {
    const original = persist({
      profile: { name: "Keep" },
      defaultModelSelection: { instanceId: "claude", model: "previous" },
    });
    const deps = dependencies();
    deps.inspect.mockRejectedValueOnce(new Error("Could not read sign-in status. Try again."));
    const ui = prompts({ choices: [0, 0, 0], confirms: [true] });
    const choose = ui.io.choose.getMockImplementation()!;
    ui.io.choose.mockImplementation(async (...args) => {
      if (args[0] === "What would you like to do?") expect(readFileSync(configPath, "utf8")).toBe(original);
      return choose(...args);
    });
    expect(await runSetup(options, ui.io, deps)).toBe(true);
    expect(deps.inspect).toHaveBeenCalledTimes(2);
    expect(deps.runCli).not.toHaveBeenCalled();
    expect(loadConfig().defaultModelSelection).toEqual({ instanceId: "claude", model: "fixture-default" });
    expect(ui.lines.join("\n")).toContain("Model access is checked by the provider when you send your first message");
    ui.assertConsumed();
    expectLeaseReleased();
  });

  it("changes connection only after an explicit recovery choice", async () => {
    const original = { driver: "claudeAgent", config: { cli: "/fixture/old-claude" } };
    persist({ instances: { work: original }, defaultModelSelection: { instanceId: "work", model: "previous" } });
    const deps = dependencies();
    deps.inspect.mockRejectedValueOnce(new Error("This sign-in could not be checked."));
    const ui = prompts({ choices: [1, 1, 0, 0], confirms: [true] });
    expect(await runSetup(options, ui.io, deps)).toBe(true);
    expect(deps.inspect.mock.calls.map(([id]) => id)).toEqual(["work", "claude"]);
    expect(loadConfig().instances?.work).toEqual(original);
    expect(loadConfig().defaultModelSelection).toEqual({ instanceId: "claude", model: "fixture-default" });
    ui.assertConsumed();
  });

  it("cancels at recovery without altering config, bots or conversations", async () => {
    const original = persist({ profile: { name: "Existing user" }, defaultModelSelection: { instanceId: "claude", model: "previous" } });
    const botsPath = join(DATA_DIR, "bots.json");
    const messagesPath = join(DATA_DIR, "messages-fixture.json");
    writeFileSync(botsPath, '[{"id":"keep"}]');
    writeFileSync(messagesPath, '[{"text":"keep conversation"}]');
    const deps = dependencies();
    deps.inspect.mockRejectedValue(new Error("Sign-in service unavailable."));
    const ui = prompts({ choices: [0, new SetupCancelled()] });
    expect(await runSetup(options, ui.io, deps)).toBe(false);
    expect(deps.inspect).toHaveBeenCalledTimes(1);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(readFileSync(botsPath, "utf8")).toBe('[{"id":"keep"}]');
    expect(readFileSync(messagesPath, "utf8")).toBe('[{"text":"keep conversation"}]');
    expect(ui.lines.join("\n")).not.toContain("Setup saved");
    ui.assertConsumed();
    expectLeaseReleased();
  });
});

describe("CLI startup preferences", () => {
  it("reads and saves preferences without changing existing provider settings", () => {
    expect(readCliStartup(DATA_DIR)).toBeUndefined();
    const existing = {
      profile: { name: "Keep" }, defaultModelSelection: { instanceId: "claude", model: "previous" },
      instances: { claude: { driver: "claudeAgent", config: { cli: "/fixture/claude" } } }, futureSetting: { keep: true },
    };
    persist(existing);
    saveCliStartup(DATA_DIR, { access: "tailscale", phone: "ios" });
    expect(readCliStartup(DATA_DIR)).toEqual({ access: "tailscale", phone: "ios" });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject(existing);
    expectLeaseReleased();
  });

  it("refuses to save while the server owns the data directory", () => {
    const original = persist({ cliStartup: { access: "local" } });
    const lease = acquireDataDirLease(DATA_DIR);
    try {
      expect(() => saveCliStartup(DATA_DIR, { access: "tunnel", phone: "android" })).toThrow(/already using this data directory/);
      expect(readFileSync(configPath, "utf8")).toBe(original);
    } finally { lease.release(); }
  });

  it("refuses corrupt configuration on both read and save", () => {
    const original = "{broken config";
    writeFileSync(configPath, original);
    expect(() => readCliStartup(DATA_DIR)).toThrow("Existing config.json");
    expect(() => saveCliStartup(DATA_DIR, { access: "local" })).toThrow("Existing config.json");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expectLeaseReleased();
  });

  it("refuses a different data directory without reading or writing it", () => {
    expect(() => readCliStartup(join(DATA_DIR, "wrong"))).toThrow("data directory mismatch");
    expect(() => saveCliStartup(join(DATA_DIR, "wrong"), { access: "local" })).toThrow("data directory mismatch");
    expect(existsSync(join(DATA_DIR, "wrong"))).toBe(false);
  });
});

describe("setup state and write boundaries", () => {
  it("requires a saved selection belonging to an enabled configured or built-in instance", async () => {
    expect(await isSetupComplete(DATA_DIR)).toBe(false);
    persist({ defaultModelSelection: { instanceId: "claude", model: "fixture" } });
    expect(await isSetupComplete(DATA_DIR)).toBe(true);
    persist({ defaultModelSelection: { instanceId: "missing", model: "fixture" } });
    expect(await isSetupComplete(DATA_DIR)).toBe(false);
    persist({ instances: { claude: { driver: "claudeAgent", enabled: false } }, defaultModelSelection: { instanceId: "claude", model: "fixture" } });
    expect(await isSetupComplete(DATA_DIR)).toBe(false);
    persist({ instances: { custom: { driver: "openai-compat" } }, defaultModelSelection: { instanceId: "custom", model: "fixture" } });
    expect(await isSetupComplete(DATA_DIR)).toBe(false);
  });

  it.each(["toString", "constructor", "__proto__"])("does not count inherited object property %s as a saved instance", async (instanceId) => {
    persist({ defaultModelSelection: { instanceId, model: "fixture" } });
    expect(await isSetupComplete(DATA_DIR)).toBe(false);
  });

  it.each(["{broken JSON", '{"instances":{"codex":{"driver":42}}}'])("refuses an unreadable existing configuration: %s", async (raw) => {
    writeFileSync(configPath, raw);
    const ui = prompts();
    const deps = dependencies();
    await expect(runSetup(options, ui.io, deps)).rejects.toThrow("Existing config.json");
    await expect(isSetupComplete(DATA_DIR)).rejects.toThrow("Existing config.json");
    expect(readFileSync(configPath, "utf8")).toBe(raw);
    expect(ui.io.choose).not.toHaveBeenCalled();
    expect(deps.inspect).not.toHaveBeenCalled();
    expectLeaseReleased();
  });

  it("refuses setup while another owner holds the data directory", async () => {
    const original = persist({ profile: { name: "Active app" } });
    const held = acquireDataDirLease(DATA_DIR);
    try {
      const ui = prompts();
      const deps = dependencies();
      await expect(runSetup(options, ui.io, deps)).rejects.toThrow(/already using this data directory/);
      expect(ui.io.choose).not.toHaveBeenCalled();
      expect(deps.inspect).not.toHaveBeenCalled();
      expect(readFileSync(configPath, "utf8")).toBe(original);
    } finally { held.release(); }
    expectLeaseReleased();
  });
});
