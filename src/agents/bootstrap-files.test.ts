import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  hasCompletedBootstrapTurn,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "./bootstrap-files.js";
import { parseInjectFrontmatter } from "./workspace.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function registerExtraBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        path: path.join(context.workspaceDir, "EXTRA.md"),
        content: "extra",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

function registerMalformedBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        filePath: path.join(context.workspaceDir, "BROKEN.md"),
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: 123,
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: "   ",
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.path === path.join(workspaceDir, "EXTRA.md"))).toBe(true);
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerMalformedBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(
      files.every((file) => typeof file.path === "string" && file.path.trim().length > 0),
    ).toBe(true);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });

  it("uses heartbeat-only bootstrap files in lightweight heartbeat mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "persona", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "heartbeat",
    });

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.name === "HEARTBEAT.md")).toBe(true);
  });

  it("keeps bootstrap context empty in lightweight cron mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "cron",
    });

    expect(files).toEqual([]);
  });

  it("drops HEARTBEAT.md for non-heartbeat runs when the heartbeat prompt section is disabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "repo rules", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            heartbeat: {
              includeSystemPromptSection: false,
            },
          },
          list: [{ id: "main" }],
        },
      },
    });

    expect(files.some((file) => file.name === "HEARTBEAT.md")).toBe(false);
    expect(files.some((file) => file.name === "AGENTS.md")).toBe(true);
  });

  it("drops HEARTBEAT.md for non-heartbeat runs when the heartbeat cadence is disabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "repo rules", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config: {
        agents: {
          defaults: {
            heartbeat: {
              every: "0m",
            },
          },
          list: [{ id: "main" }],
        },
      },
    });

    expect(files.some((file) => file.name === "HEARTBEAT.md")).toBe(false);
    expect(files.some((file) => file.name === "AGENTS.md")).toBe(true);
  });

  it("keeps HEARTBEAT.md for actual heartbeat runs even when the prompt section is disabled", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      runKind: "heartbeat",
      config: {
        agents: {
          defaults: {
            heartbeat: {
              includeSystemPromptSection: false,
            },
          },
          list: [{ id: "main" }],
        },
      },
    });

    expect(files.some((file) => file.name === "HEARTBEAT.md")).toBe(true);
  });
});

describe("hasCompletedBootstrapTurn", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "openclaw-bootstrap-turn-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false when session file does not exist", async () => {
    expect(await hasCompletedBootstrapTurn(path.join(tmpDir, "missing.jsonl"))).toBe(false);
  });

  it("returns false for empty session files", async () => {
    const sessionFile = path.join(tmpDir, "empty.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns false for header-only session files", async () => {
    const sessionFile = path.join(tmpDir, "header-only.jsonl");
    await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "s1" })}\n`, "utf8");
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns false when no assistant turn has been flushed yet", async () => {
    const sessionFile = path.join(tmpDir, "user-only.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns false for assistant turns without a recorded full bootstrap marker", async () => {
    const sessionFile = path.join(tmpDir, "assistant-no-marker.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns true when a full bootstrap completion marker exists", async () => {
    const sessionFile = path.join(tmpDir, "full-bootstrap.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("returns false when compaction happened after the last assistant turn", async () => {
    const sessionFile = path.join(tmpDir, "post-compaction.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
        }),
        JSON.stringify({ type: "compaction", summary: "trimmed" }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(false);
  });

  it("returns true when a later full bootstrap marker happens after compaction", async () => {
    const sessionFile = path.join(tmpDir, "assistant-after-compaction.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
        }),
        JSON.stringify({ type: "compaction", summary: "trimmed" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "new ask" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "new reply" } }),
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 2 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("ignores malformed JSON lines", async () => {
    const sessionFile = path.join(tmpDir, "malformed.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        "{broken",
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("finds a recent full bootstrap marker even when the scan starts mid-file", async () => {
    const sessionFile = path.join(tmpDir, "large-prefix.jsonl");
    const hugePrefix = "x".repeat(300 * 1024);
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: hugePrefix } }),
        JSON.stringify({
          type: "custom",
          customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
          data: { timestamp: 1 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(await hasCompletedBootstrapTurn(sessionFile)).toBe(true);
  });

  it("returns false for symbolic links", async () => {
    const realFile = path.join(tmpDir, "real.jsonl");
    const linkFile = path.join(tmpDir, "link.jsonl");
    await fs.writeFile(
      realFile,
      `${JSON.stringify({ type: "custom", customType: FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, data: { timestamp: 1 } })}\n`,
      "utf8",
    );
    await fs.symlink(realFile, linkFile);
    expect(await hasCompletedBootstrapTurn(linkFile)).toBe(false);
  });
});

describe("resolveContextInjectionMode", () => {
  it("defaults to always when config is missing", () => {
    expect(resolveContextInjectionMode(undefined)).toBe("always");
  });

  it("defaults to always when the setting is omitted", () => {
    expect(resolveContextInjectionMode({ agents: { defaults: {} } } as never)).toBe("always");
  });

  it("returns the configured continuation-skip mode", () => {
    expect(
      resolveContextInjectionMode({
        agents: { defaults: { contextInjection: "continuation-skip" } },
      } as never),
    ).toBe("continuation-skip");
  });
});

describe("parseInjectFrontmatter", () => {
  it("returns undefined when no frontmatter is present", () => {
    expect(parseInjectFrontmatter("# HEARTBEAT.md\ncheck inbox")).toBeUndefined();
  });

  it("returns undefined when frontmatter has no inject field", () => {
    expect(parseInjectFrontmatter("---\ntitle: test\n---\n# content")).toBeUndefined();
  });

  it("parses inject: always", () => {
    expect(parseInjectFrontmatter("---\ninject: always\n---\n# content")).toBe("always");
  });

  it("parses inject: heartbeat-only", () => {
    expect(parseInjectFrontmatter("---\ninject: heartbeat-only\n---\n# content")).toBe(
      "heartbeat-only",
    );
  });

  it("parses inject: main-session-only", () => {
    expect(parseInjectFrontmatter("---\ninject: main-session-only\n---\n# content")).toBe(
      "main-session-only",
    );
  });

  it("parses inject: never", () => {
    expect(parseInjectFrontmatter("---\ninject: never\n---\n# content")).toBe("never");
  });

  it("returns undefined for an unrecognised inject value (falls back to always)", () => {
    expect(parseInjectFrontmatter("---\ninject: sometimes\n---\n# content")).toBeUndefined();
  });

  it("handles frontmatter with other fields before inject", () => {
    expect(
      parseInjectFrontmatter("---\ntitle: My File\ninject: heartbeat-only\n---\n# content"),
    ).toBe("heartbeat-only");
  });
});

describe("applyInjectModeFilter (via resolveBootstrapFilesForRun)", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("includes files with no inject frontmatter (defaults to always)", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-inject-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# SOUL\npersona", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    expect(files.some((f) => f.name === "SOUL.md")).toBe(true);
  });

  it("excludes files with inject: never", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-inject-");
    await fs.writeFile(
      path.join(workspaceDir, "SOUL.md"),
      "---\ninject: never\n---\n# SOUL\npersona",
      "utf8",
    );

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    expect(files.some((f) => f.name === "SOUL.md")).toBe(false);
  });

  it("includes inject: heartbeat-only files only in heartbeat runs", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-inject-");
    await fs.writeFile(
      path.join(workspaceDir, "HEARTBEAT.md"),
      "---\ninject: heartbeat-only\n---\ncheck inbox",
      "utf8",
    );

    const heartbeatFiles = await resolveBootstrapFilesForRun({
      workspaceDir,
      runKind: "heartbeat",
    });
    expect(heartbeatFiles.some((f) => f.name === "HEARTBEAT.md")).toBe(true);

    const defaultFiles = await resolveBootstrapFilesForRun({
      workspaceDir,
      runKind: "default",
    });
    expect(defaultFiles.some((f) => f.name === "HEARTBEAT.md")).toBe(false);
  });

  it("includes inject: main-session-only files for regular sessions but not subagent sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-inject-");
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "---\ninject: main-session-only\n---\n# Memory",
      "utf8",
    );

    // Regular (main) session — no sessionKey
    const mainFiles = await resolveBootstrapFilesForRun({ workspaceDir });
    expect(mainFiles.some((f) => f.name === "MEMORY.md")).toBe(true);

    // Subagent session key — should be filtered out
    const subagentFiles = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:subagent:abc123",
    });
    expect(subagentFiles.some((f) => f.name === "MEMORY.md")).toBe(false);
  });

  it("includes inject: main-session-only files but not for cron sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-inject-");
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "---\ninject: main-session-only\n---\n# Memory",
      "utf8",
    );

    const cronFiles = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:cron:job:run:xyz",
    });
    expect(cronFiles.some((f) => f.name === "MEMORY.md")).toBe(false);
  });

  it("includes inject: always files in every context", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-inject-");
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "---\ninject: always\n---\n# AGENTS\nrules",
      "utf8",
    );

    const regularFiles = await resolveBootstrapFilesForRun({ workspaceDir });
    expect(regularFiles.some((f) => f.name === "AGENTS.md")).toBe(true);

    const heartbeatFiles = await resolveBootstrapFilesForRun({
      workspaceDir,
      runKind: "heartbeat",
    });
    expect(heartbeatFiles.some((f) => f.name === "AGENTS.md")).toBe(true);
  });

  it("ignores invalid inject values and defaults to always", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-inject-");
    await fs.writeFile(
      path.join(workspaceDir, "SOUL.md"),
      "---\ninject: sometimes\n---\n# SOUL\npersona",
      "utf8",
    );

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    // Invalid inject → undefined → defaults to "always" → included
    expect(files.some((f) => f.name === "SOUL.md")).toBe(true);
  });
});
