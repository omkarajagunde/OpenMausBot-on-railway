// Guided setup stays outside server/index: no server, store, or bot is started
// until the user has saved a connection and explicitly starts the application.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DATA_DIR, instanceConfigs, loadConfig, parseStoredConfig, saveConfig,
  stripWorkspaceCredentialEnv, PROVIDER_CREDENTIAL_ENV, type AppConfig,
} from "./config.ts";
import type { InstanceConfig, ModelCatalog, ProviderSnapshot } from "./contracts.ts";
import { acquireDataDirLease } from "./data-dir-lease.ts";
import { augmentedPath, resetPathCache } from "./env-path.ts";
import { resolveCli } from "./procs.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { defaultSetupIo, SetupCancelled, type SetupIo } from "./cli-prompts.ts";

type Inspection = { snapshot: ProviderSnapshot; models: ModelCatalog };
interface SetupDependencies {
  inspect(id: string, entry: InstanceConfig): Promise<Inspection>;
  runCli(cli: string, args: string[], environment?: Record<string, string>): Promise<void>;
}

async function inspect(id: string, entry: InstanceConfig): Promise<Inspection> {
  const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
  try {
    await registry.load({ [id]: entry });
    const provider = registry.get(id);
    if (!provider) throw new Error("This provider configuration could not be loaded. Check it in app Settings.");
    const snapshot = await provider.snapshot();
    return { snapshot, models: provider.models };
  } finally {
    await registry.disposeAll();
  }
}

/** Native CLIs own their OAuth flow; no tokens pass through our prompts. */
export async function runSetupCli(cli: string, args: string[], environment: Record<string, string> = {}): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...environment, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const command = resolveCli(cli, args);
  await new Promise<void>((done, reject) => {
    const child = spawn(command.command, command.args, { env, stdio: "inherit" });
    child.once("error", () => reject(new Error(`Could not start ${cli}. Check that it is installed and on PATH.`)));
    child.once("exit", (code, signal) => {
      if (code === 0) done();
      else if (signal === "SIGINT" || code === 130) reject(new SetupCancelled());
      else reject(new Error(`${cli} did not finish successfully. Fix the error shown above, then try again.`));
    });
  });
  resetPathCache();
}

const dependencies: SetupDependencies = { inspect, runCli: runSetupCli };

function assertDataDir(dataDir: string): void {
  if (resolve(dataDir) !== resolve(DATA_DIR)) throw new Error("Setup data directory mismatch. Restart the CLI with --data-dir.");
}

// loadConfig tolerates a broken file at boot; an onboarding write must refuse one rather than replace its contents.
function checkStoredConfig(dataDir: string): void {
  try {
    parseStoredConfig(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Existing config.json could not be read or validated. Setup has not changed it; repair it before continuing.");
  }
}

export async function isSetupComplete(dataDir: string): Promise<boolean> {
  assertDataDir(dataDir);
  checkStoredConfig(dataDir);
  const cfg = loadConfig();
  const saved = cfg.defaultModelSelection;
  const instances = instanceConfigs(cfg);
  return !!(saved && Object.hasOwn(instances, saved.instanceId) && instances[saved.instanceId]?.enabled !== false);
}

export function readCliStartup(dataDir: string): AppConfig["cliStartup"] {
  assertDataDir(dataDir);
  checkStoredConfig(dataDir);
  return loadConfig().cliStartup;
}

export function saveCliStartup(dataDir: string, settings: NonNullable<AppConfig["cliStartup"]>): void {
  assertDataDir(dataDir);
  const lease = acquireDataDirLease(dataDir);
  try {
    checkStoredConfig(dataDir);
    saveConfig({ cliStartup: settings });
  } finally {
    lease.release();
  }
}

function rawObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function chooseModel(io: SetupIo, models: ModelCatalog): Promise<string> {
  if (!models.options.length) throw new Error("This connection returned no models. Check the provider and try again.");
  let query = "";
  for (;;) {
    const matches = models.options.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(query.toLowerCase()));
    const preferred = matches.find((m) => m.id === models.default);
    const visible = (preferred ? [preferred, ...matches.filter((m) => m !== preferred)] : matches).slice(0, 20);
    const defaultIndex = visible.findIndex((m) => m.id === models.default);
    const selected = await io.choose("Choose your model", [
      ...visible.map((m) => m.label.trim() || m.id),
      "Search models…",
    ], defaultIndex < 0 ? undefined : defaultIndex);
    if (selected < visible.length) return visible[selected]!.id;
    query = (await io.ask("Model name or part of its ID (Enter shows all): ")).trim();
  }
}

const CLAUDE = { id: "claude", driver: "claudeAgent", label: "Claude Code — sign in with your account", cli: "claude", pkg: "@anthropic-ai/claude-code" } as const;

async function connectNative(
  choice: typeof CLAUDE, id: string, entry: InstanceConfig, io: SetupIo, deps: SetupDependencies,
): Promise<ModelCatalog> {
  const cli = typeof rawObject(entry.config).cli === "string" ? rawObject(entry.config).cli as string : choice.cli;
  io.log("Connecting your account…");
  io.log("Sign-in stays with your provider. Its account limits apply; OpenMausBot never asks for your password.");
  let state = await deps.inspect(id, entry);
  if (state.snapshot.state !== "available") {
    if (cli !== choice.cli) throw new Error("Your custom CLI path is unavailable. Fix that path in Settings before running setup again.");
    if (!await io.confirm(`Install ${choice.cli} with npm install -g ${choice.pkg}?`, true)) throw new SetupCancelled();
    await deps.runCli("npm", ["install", "-g", choice.pkg]);
    state = await deps.inspect(id, entry);
    if (state.snapshot.state !== "available") throw new Error(`${choice.cli} is still unavailable. Check the installation output and try again.`);
  }
  if (!state.snapshot.authenticated) {
    await deps.runCli(cli, ["auth", "login"], entry.environment);
    state = await deps.inspect(id, entry);
    if (state.snapshot.state !== "available" || !state.snapshot.authenticated) {
      throw new Error("Sign-in was not confirmed. Your OpenMausBot settings are unchanged; complete provider sign-in and try again.");
    }
  } else {
    io.log("Existing sign-in found — you do not need to sign in again.");
  }
  if (state.snapshot.update) io.log(`${state.snapshot.update.title}: ${state.snapshot.update.command}`);
  io.log("Sign-in confirmed. Model access is checked by the provider when you send your first message.");
  return state.models;
}

export async function runSetup(
  options: { dataDir: string; port: number },
  io: SetupIo = defaultSetupIo(),
  deps: SetupDependencies = dependencies,
): Promise<boolean> {
  assertDataDir(options.dataDir);
  const lease = acquireDataDirLease(options.dataDir);
  try {
    checkStoredConfig(options.dataDir);
    const cfg = loadConfig();
    const runtime = instanceConfigs(cfg);
    const existing = Object.entries(runtime).filter(([id, entry]) =>
      !!cfg.instances?.[id] && entry.driver === "claudeAgent" && entry.enabled !== false);
    io.log("\nWelcome to OpenMausBot\n");
    io.log("Let's connect Claude Code, then choose a model.");
    io.log("Existing bots and conversations stay untouched. Ctrl-C cancels.");
    io.log("You can add integrations and change settings later.\n");
    const existingDefault = existing.findIndex(([id]) => id === cfg.defaultModelSelection?.instanceId);
    const providerOptions = [
      CLAUDE.label,
      ...existing.map(([id, entry]) => `Use existing: ${entry.displayName ?? id}${id === cfg.defaultModelSelection?.instanceId ? " — current" : ""}`),
    ];
    let pick: number | undefined;

    let id: string;
    let entry: InstanceConfig;
    let model: string;
    for (;;) {
      pick ??= await io.choose("Choose your AI connection", providerOptions, existingDefault < 0 ? 0 : existingDefault + 1);
      const prior = pick >= 1 ? existing[pick - 1] : undefined;
      try {
        // Reuse saved Claude settings; an ID the user repurposed for another engine is left alone.
        id = prior?.[0] ?? CLAUDE.id;
        if (!prior && cfg.instances?.[id] && cfg.instances[id]!.driver !== CLAUDE.driver) id = `${CLAUDE.id}-${Date.now().toString(36)}`;
        entry = { ...(cfg.instances?.[id] ?? { driver: CLAUDE.driver }), enabled: true };
        const models = await connectNative(CLAUDE, id, entry, io, deps);
        const saved = cfg.defaultModelSelection;
        model = await chooseModel(io, {
          ...models,
          default: saved?.instanceId === id ? saved.model : models.default,
        });
        break;
      } catch (error) {
        if (error instanceof SetupCancelled) throw error;
        io.log(error instanceof Error ? error.message : "This connection could not be set up.");
        io.log("Your saved connection and model have not changed.");
        const recovery = await io.choose("What would you like to do?", [
          "Try this connection again", "Choose another connection", "Cancel setup",
        ], 0);
        if (recovery === 2) throw new SetupCancelled();
        if (recovery === 1) pick = undefined;
      }
    }

    io.log(`\nDefault for new bots: ${entry.displayName ?? id} / ${model}`);
    if (!await io.confirm("Save this setup?", true)) throw new SetupCancelled();
    // An explicit fleet starts from an empty config's defaults, not instanceConfigs(cfg), whose env holds secrets.
    const instances = { ...(cfg.instances && Object.keys(cfg.instances).length ? cfg.instances : instanceConfigs({})), [id]: entry };
    saveConfig({ instances, defaultModelSelection: { instanceId: id, model } });
    io.log("\nSetup saved. Existing bots and conversations were not changed.");
    return true;
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    io.log("\nSetup cancelled. No OpenMausBot settings were changed. Provider sign-ins or installs already completed are kept.");
    return false;
  } finally {
    lease.release();
  }
}
