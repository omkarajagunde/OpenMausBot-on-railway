import { describe, expect, it } from "vitest";

import type { SendTurnInput } from "./contracts.ts";
import { appMountFor, gateServer, mcpStdioServer } from "./mcp-gate-config.ts";

const HARNESS = "http://127.0.0.1:8799";
const agents = { command: process.execPath, args: ["agents-proxy.js"], env: { OMB_HARNESS_URL: HARNESS, OMB_COMMS_TOKEN: "comms-fixture" } };
const board = { command: "board-mcp", args: ["--stdio"], env: { BOARD_KEY: "k" } };
const notes = { command: "notes-mcp", args: [], env: {} };
const draw = { type: "http" as const, url: "https://draw.example/mcp", headers: { Authorization: "Bearer d" } };
const docs = { type: "http" as const, url: "https://docs.example/mcp", headers: {} };
const mount = (server: string, extension = true) => ({ server, harnessUrl: HARNESS, token: "comms-fixture", extension });
const APPS = { board: { extension: true }, draw: { extension: true } };

type Turn = Pick<SendTurnInput, "threadId" | "text" | "integrations" | "toolScope">;
const turn = (extra: Partial<Turn> = {}): SendTurnInput => ({ threadId: "t-apps", text: "go", integrations: { agents, custom: { board, notes, draw, docs }, mcpApps: APPS }, ...extra }) as SendTurnInput;
const env = (descriptor: { env?: Record<string, string> } | undefined, key: string) => {
  const value = descriptor?.env?.[key];
  return value === undefined ? undefined : JSON.parse(value);
};

describe("the shared decision", () => {
  it("observes a server only when the turn names it as an app server, mounts it and can report", () => {
    expect(appMountFor("board", turn())).toEqual(mount("board"));
    expect(appMountFor("notes", turn())).toBeUndefined();
    expect(appMountFor("board", turn({ integrations: { agents, custom: { board } } }))).toBeUndefined();
    expect(appMountFor("board", turn({ integrations: { custom: { board }, mcpApps: APPS } }))).toBeUndefined();
    expect(appMountFor("board", turn({ integrations: { agents, custom: {}, mcpApps: APPS } }))).toBeUndefined();
    expect(appMountFor("board", turn({ integrations: { agents, custom: { board }, mcpApps: { board: { extension: false } } } }))).toEqual(mount("board", false));
  });

  it("gates a command app server with no budget or selection, and puts its settings in a private record when asked", () => {
    const gated = gateServer({ name: "board", server: board, threadId: "t", budget: 0, apps: mount("board") })!;
    expect(gated.args[0]).toContain("mcp-gate");
    expect(env(gated, "OMB_GATE_APPS")).toEqual(mount("board"));
    expect(env(gated, "OMB_GATE_UPSTREAM")).toEqual(board);
    expect(gated.env).not.toHaveProperty("OMB_GATE_TOOL_SCOPE");
    const record = `OMB_GATE_CONFIG_${"a".repeat(64)}`;
    const shared = gateServer({ name: "board", server: board, threadId: "t", budget: 0, apps: mount("board"), configEnvName: record })!;
    expect(Object.keys(shared.env)).toEqual([record]);
    expect(JSON.parse(JSON.parse(shared.env[record]!).OMB_GATE_APPS)).toEqual(mount("board"));
    // a private record is still refused for a gate that neither selects nor observes
    expect(() => gateServer({ name: "notes", server: notes, threadId: "t", budget: 5, configEnvName: record })).toThrow(/private MCP gate/);
  });

  it("observes a URL app server in the proxy: alone without a selection, inside a gate that does not observe with one", () => {
    const proxy = gateServer({ name: "draw", server: draw, threadId: "t", budget: 1_000, apps: mount("draw"), directory: true })!;
    expect(proxy.args[0]).toContain("mcp-remote-proxy");
    expect(env(proxy, "OMB_REMOTE_MCP_APPS")).toEqual(mount("draw"));
    expect(env(proxy, "OMB_REMOTE_MCP_DIRECTORY")).toEqual({ name: "draw" });
    const gated = gateServer({ name: "draw", server: draw, threadId: "t", budget: 0, toolScope: { allow: ["mcp:draw:*"] }, apps: mount("draw") })!;
    expect(gated.args[0]).toContain("mcp-gate");
    expect(gated.env).not.toHaveProperty("OMB_GATE_APPS");
    expect(env(env(gated, "OMB_GATE_UPSTREAM"), "OMB_REMOTE_MCP_APPS")).toEqual(mount("draw"));
  });

  it("leaves a server without apps byte for byte as before", () => {
    for (const [server, budget] of [[notes, 0], [notes, 2_000], [docs, 0], [docs, 2_000]] as const) {
      expect(gateServer({ name: "x", server, threadId: "t", budget, apps: undefined })).toEqual(gateServer({ name: "x", server, threadId: "t", budget }));
    }
    expect(mcpStdioServer(docs, { apps: undefined })).toEqual(mcpStdioServer(docs));
  });
});
