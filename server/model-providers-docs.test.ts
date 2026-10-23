// Pins each workaround the "Other model providers" docs page gives to the code it depends on: when one fails, update the page.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { OPENCODE_PROVIDER_ENV, PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "./config.ts";
import { readClaudeAuthSettings, readClaudeModelCatalog } from "./drivers/claude.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = readFileSync(join(ROOT, "apps", "docs", "content", "docs", "providers", "model-providers.mdx"), "utf8");
const EN = JSON.parse(readFileSync(join(ROOT, "src", "locales", "en.json"), "utf8")) as Record<string, string>;

function section(heading: string): string {
  const lines = PAGE.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === heading);
  expect(start, `the page has no "${heading}" heading`).toBeGreaterThanOrEqual(0);
  const level = heading.indexOf(" ");
  const end = lines.findIndex((line, index) => index > start && /^#+ /u.test(line) && line.indexOf(" ") <= level);
  return flat(lines.slice(start + 1, end < 0 ? undefined : end).join("\n"));
}

const flat = (text: string) => text.replace(/\s+/gu, " ");

const scratchDirs: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) await removeTempDir(dir);
});

describe("Claude Code section", () => {
  // Shell exports as copied into the env block, plus FireConnect's header and model settings. Every value is fake.
  const settingsHome = (env: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const home = scratch("omb-docs-claude-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ ...extra, env }));
    return home;
  };
  const providerEnv = {
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: "sk-or-fake",
    ANTHROPIC_CUSTOM_HEADERS: "X-Fireworks-Api-Key: fw_fake",
    ANTHROPIC_MODEL: "deepseek/deepseek-chat",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek/deepseek-reasoner",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek/deepseek-subagent",
  };

  it("sends people to the settings.json env block, which Claude bots carry over", () => {
    const home = settingsHome(providerEnv);

    expect(readClaudeAuthSettings({ HOME: home }).env).toEqual({
      ANTHROPIC_BASE_URL: providerEnv.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: providerEnv.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_CUSTOM_HEADERS: providerEnv.ANTHROPIC_CUSTOM_HEADERS,
    });

    const text = section("### Claude Code");
    expect(text).toContain("Put `ANTHROPIC_BASE_URL` and your key in the `env` block of `~/.claude/settings.json`.");
    expect(text).toContain("OpenRouter's and DeepSeek's guides use shell exports, which the desktop app doesn't see, so copy those lines into the `env` block.");
    expect(text).not.toMatch(/Those guides put/u);
    expect(text).toContain("On a server, use the `env` block too, not exports in the terminal that starts the server.");
  });

  it("lists ANTHROPIC_MODEL and non-Claude tier models under the picker entry the page names, and nothing else from the file", () => {
    const home = settingsHome(providerEnv, {
      modelPicker: { options: [{ model: "glm-latest[1m]", label: "GLM" }] },
    });
    const catalog = readClaudeModelCatalog({ HOME: home });
    const custom = catalog.options.filter((option) => option.custom).map((option) => option.id);

    expect(custom).toEqual([providerEnv.ANTHROPIC_MODEL, providerEnv.ANTHROPIC_DEFAULT_SONNET_MODEL]);
    expect(JSON.stringify(catalog)).not.toContain(providerEnv.CLAUDE_CODE_SUBAGENT_MODEL);
    expect(JSON.stringify(catalog)).not.toContain("glm-latest");
    const carried = Object.keys(readClaudeAuthSettings({ HOME: home }).env ?? {});
    expect(carried.filter((key) => /MODEL/u.test(key))).toEqual([]);

    const label = EN["model.useLocal"];
    expect(label).toBe("Use a local model");
    const text = section("### Claude Code");
    expect(text).toContain(`If you also set \`ANTHROPIC_MODEL\` there, that model appears under **${label}** in the Claude model picker; pick it.`);
    expect(text).toContain("FireConnect's model list doesn't show up in OpenMausBot, so add `ANTHROPIC_MODEL` yourself.");
    expect(text).toContain("So do `ANTHROPIC_CUSTOM_MODEL_OPTION` and each `ANTHROPIC_DEFAULT_*_MODEL` that isn't a Claude model.");
    expect(text).toContain("`ANTHROPIC_DEFAULT_*_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` aren't carried over.");
    expect(text).not.toMatch(/such as `ANTHROPIC_MODEL`, aren't carried/u);
  });

  it("drops that setup while an Anthropic key is saved in Connections, as the page says", () => {
    const home = settingsHome(providerEnv);
    expect(readClaudeAuthSettings({ HOME: home }, { ANTHROPIC_API_KEY: "connections-fake-key" })).toEqual({});
    expect(section("### Claude Code")).toContain("It applies only while no Anthropic API key is saved in Connections.");
  });
});

describe("Keys exported on a server", () => {
  const exported = ["OPENROUTER_API_KEY", "FIREWORKS_API_KEY", "DEEPSEEK_API_KEY"];

  it("reach every engine, as the page warns", () => {
    // Every engine filters its inherited environment through these two lists (or stripWorkspaceCredentialEnv).
    const filtered = new Set<string>([...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]);
    expect(exported.filter((name) => filtered.has(name))).toEqual([]);
    const env: Record<string, string | undefined> = Object.fromEntries(exported.map((name) => [name, "fake"]));
    stripWorkspaceCredentialEnv(env);
    expect(Object.keys(env).sort()).toEqual([...exported].sort());

    const text = section("### OpenCode");
    for (const name of exported) expect(text).toContain(`\`${name}\``);
    expect(text).toContain("Keys exported this way reach every engine on that server, and any bot that can run commands can read them.");
  });

  it("documents Cline's separate credential scope and native setup", () => {
    expect(PROVIDER_CREDENTIAL_ENV).toContain("CLINE_API_KEY");
    expect(OPENCODE_PROVIDER_ENV).toContain("CLINE_API_KEY");
    expect(section("### OpenCode")).toContain("`CLINE_API_KEY` is scoped to the Cline and OpenCode engines.");
    const cline = section("### Cline engine");
    expect(cline).toContain("`cline auth`");
    expect(cline).toContain("**Cline default (configured)**");
    expect(cline).toContain("An unconfigured account remains unavailable.");
  });

});
