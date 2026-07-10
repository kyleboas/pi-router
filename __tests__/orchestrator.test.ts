import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _test, resolveOrchestrationCast, resolveRouterConfig } from "../extensions/index.js";
import {
	buildDelegateArgs,
	createConsultTool,
	createDelegateTool,
	type DelegateActivityEvent,
	type DelegateUsage,
	type ResolvedOrchestrationConfig,
	runDelegate,
} from "../extensions/orchestrator.js";

const usage: DelegateUsage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, costTotal: 0.0123 };
const config: ResolvedOrchestrationConfig = {
	enabled: true,
	primary: { provider: "openai-codex", id: "gpt-5.6-sol" },
	workers: {
		mid: { provider: "openai-codex", id: "gpt-5.6-terra", thinking: "medium" },
		small: { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "low" },
	},
	consultants: { fable: { provider: "claude-cli", id: "claude-fable-5" } },
	explicit: { primary: false, mid: false, small: false },
	delegateTimeoutMs: 1000,
	consultTimeoutMs: 1000,
	maxConcurrent: 1,
	maxOutputChars: 100,
};

const originalPiBin = process.env.PI_BIN;
afterEach(() => {
	if (originalPiBin === undefined) delete process.env.PI_BIN;
	else process.env.PI_BIN = originalPiBin;
});

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "pi-router-orchestrator-"));
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function context(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

describe("orchestrator", () => {
	it("parses defaults, diagnostics, and project worker overrides", () => {
		const { root, cleanup } = workspace();
		try {
			const home = join(root, "home");
			const cwd = join(root, "project");
			mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				join(home, ".pi", "agent", "extensions", "router.json"),
				JSON.stringify({ orchestration: { enabled: true, workers: { mid: "openai-codex/global:low" } } }),
			);
			writeFileSync(
				join(cwd, ".pi", "extensions", "router.json"),
				JSON.stringify({ orchestration: { workers: { small: "bad" }, maxConcurrent: 3 } }),
			);
			const parsed = resolveRouterConfig(cwd, home);
			expect(parsed.orchestration).toMatchObject({ enabled: true, maxConcurrent: 3 });
			expect(parsed.orchestration.workers.mid.id).toBe("global");
			expect(parsed.orchestration.workers.small.id).toBe("gpt-5.6-luna");
			expect(parsed.diagnostics.map((entry) => entry.message).join("\n")).toContain("Invalid model spec");
			expect(_test.parseOrchestrationConfig().primary.id).toBe("gpt-5.6-sol");
		} finally {
			cleanup();
		}
	});

	it("derives casts from scoped and explicit pools", () => {
		const { root, cleanup } = workspace();
		try {
			const home = join(root, "home");
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "settings.json"),
				JSON.stringify({
					scopedModels: [
						"openai-codex/gpt-5.6",
						"openai-codex/gpt-5.6-sol",
						"openai-codex/gpt-5.6-terra",
						"openai-codex/gpt-5.6-luna",
					],
				}),
			);
			writeFileSync(
				join(cwd, ".pi", "extensions", "router.json"),
				JSON.stringify({ orchestration: { pool: "scoped" } }),
			);
			const scoped = resolveRouterConfig(cwd, home).orchestration;
			expect(scoped.poolSource).toBe("scoped");
			expect(resolveOrchestrationCast(scoped, () => true)).toMatchObject({
				primary: { id: "gpt-5.6" },
				mid: { id: "gpt-5.6-terra", thinking: "medium" },
				small: { id: "gpt-5.6-luna", thinking: "low" },
			});
			expect(resolveOrchestrationCast(scoped, (spec) => spec.id !== "gpt-5.6").primary.id).toBe("gpt-5.6-sol");

			const explicit = _test.parseOrchestrationConfig({
				pool: ["openai-codex/one", "bad", "openai-codex/two", "openai-codex/three"],
				workers: { small: "openai-codex/explicit-small" },
			});
			expect(explicit.poolSource).toBe("explicit");
			expect(resolveOrchestrationCast(explicit, () => true)).toMatchObject({
				primary: { id: "one" },
				mid: { id: "two", thinking: "medium" },
				small: { id: "explicit-small" },
			});
			const diagnostics: Array<{ severity: "warning" | "error" | "info"; path: string; message: string }> = [];
			_test.parseOrchestrationConfig({ pool: ["bad"] }, diagnostics);
			expect(diagnostics.map((entry) => entry.message).join("\n")).toContain("Invalid model spec");
		} finally {
			cleanup();
		}
	});

	it("builds worker argv and parses streamed worker output", async () => {
		const { root, cleanup } = workspace();
		try {
			const sessionPath = join(root, "delegate.jsonl");
			expect(buildDelegateArgs(config.workers.small, "do it", ["read", "write"], sessionPath)).toEqual([
				"--mode",
				"json",
				"-p",
				"--provider",
				"openai-codex",
				"--model",
				"gpt-5.6-luna",
				"--thinking",
				"low",
				"--tools",
				"read,write",
				"--no-extensions",
				"--no-context-files",
				"--session",
				sessionPath,
				"--append-system-prompt",
				expect.any(String),
				"do it",
			]);
			const bin = join(root, "fake-pi.sh");
			writeFileSync(
				bin,
				`#!/usr/bin/env bash\necho garbage\necho '{"type":"tool_execution_start","toolName":"write","args":{"path":"made.txt"}}'\necho '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":2,"output":3,"cacheRead":4,"cacheWrite":5,"totalTokens":14,"cost":{"total":0.0123}}}}'\n`,
			);
			chmodSync(bin, 0o755);
			process.env.PI_BIN = bin;
			const result = await runDelegate({
				spec: config.workers.small,
				task: "do it",
				tools: ["read"],
				sessionPath,
				cwd: root,
				timeoutMs: 1000,
			});
			expect(result).toMatchObject({ ok: true, text: "done", filesTouched: ["made.txt"], usage });
		} finally {
			cleanup();
		}
	});

	it("refuses mutating workers when isolation cannot be established", async () => {
		const { root, cleanup } = workspace();
		try {
			const result = await runDelegate({
				spec: config.workers.small,
				task: "mutate",
				tools: ["bash"],
				sessionPath: join(root, "delegate.jsonl"),
				cwd: root,
				timeoutMs: 5000,
			});
			expect(result).toMatchObject({ ok: false, costKnown: false });
			expect(result.diagnostic).toContain("require a git worktree");
		} finally {
			cleanup();
		}
	});

	it("isolates mutating workers and applies a derived patch", async () => {
		const { root, cleanup } = workspace();
		try {
			execFileSync("git", ["init", root]);
			writeFileSync(join(root, "tracked.txt"), "before\n");
			execFileSync("git", ["-C", root, "add", "tracked.txt"]);
			execFileSync("git", [
				"-C",
				root,
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"base",
			]);
			const bin = join(root, "fake-pi.sh");
			writeFileSync(
				bin,
				`#!/usr/bin/env bash\nprintf 'after\\n' > tracked.txt\nprintf 'new\\n' > unreported.txt\necho '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}'\n`,
			);
			chmodSync(bin, 0o755);
			process.env.PI_BIN = bin;
			const result = await runDelegate({
				spec: config.workers.small,
				task: "mutate through bash",
				tools: ["bash"],
				sessionPath: join(root, "delegate.jsonl"),
				cwd: root,
				timeoutMs: 5000,
			});
			expect(result.ok).toBe(true);
			expect(result.filesTouched).toEqual(["tracked.txt", "unreported.txt"]);
			expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("after\n");
			expect(readFileSync(join(root, "unreported.txt"), "utf8")).toBe("new\n");
			expect(result.filesTouched).not.toContain("fake-pi.sh");
		} finally {
			cleanup();
		}
	});

	it("returns an error result for worker error events", async () => {
		const { root, cleanup } = workspace();
		try {
			const bin = join(root, "fake-pi.sh");
			writeFileSync(
				bin,
				'#!/usr/bin/env bash\necho \'{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"bad worker"}}\'\n',
			);
			chmodSync(bin, 0o755);
			process.env.PI_BIN = bin;
			const result = await runDelegate({
				spec: config.workers.small,
				task: "x",
				tools: ["read"],
				sessionPath: join(root, "x.jsonl"),
				cwd: root,
				timeoutMs: 1000,
			});
			expect(result).toMatchObject({ ok: false, diagnostic: "bad worker" });
		} finally {
			cleanup();
		}
	});

	it("guards delegation and records delegate and consult usage", async () => {
		const { root, cleanup } = workspace();
		try {
			const records: Array<Record<string, unknown>> = [];
			const activities: DelegateActivityEvent[] = [];
			let slots = 0;
			const runner = vi.fn(async () => ({
				ok: true,
				text: "worker report",
				filesTouched: ["a.ts"],
				usage,
				costKnown: true,
				latencyMs: 12,
			}));
			const delegate = createDelegateTool({
				getConfig: () => config,
				getCast: () => ({ primary: config.primary, mid: config.workers.mid, small: config.workers.small }),
				isEnabled: () => true,
				acquireSlot: () => (slots++ ? undefined : () => undefined),
				delegateDir: () => join(root, "delegates"),
				recordUsage: (record) => records.push(record),
				runner,
				isWorkerAvailable: () => true,
				onDelegateActivity: (event) => activities.push(event),
			});
			const first = await delegate.execute(
				"x",
				{ task: "brief", worker: "small", tools: ["read"], expectation: "test" },
				undefined,
				undefined,
				context(root),
			);
			expect(first.content[0]).toMatchObject({ text: expect.stringContaining("delegateId=d-") });
			expect(records[0]).toMatchObject({ kind: "delegate", worker: "small", usage, costKnown: true });
			expect(activities.map((event) => event.phase)).toEqual(["start", "finish"]);
			const blocked = await delegate.execute(
				"x",
				{ task: "brief", worker: "small", tools: ["read"] },
				undefined,
				undefined,
				context(root),
			);
			expect(blocked.content[0]).toMatchObject({ text: expect.stringContaining("concurrency") });
			const budgetRunner = vi.fn();
			const budgetBlocked = createDelegateTool({
				getConfig: () => config,
				getCast: () => ({ primary: config.primary, mid: config.workers.mid, small: config.workers.small }),
				isEnabled: () => true,
				acquireSlot: () => vi.fn(),
				delegateDir: () => root,
				recordUsage: vi.fn(),
				runner: budgetRunner,
				isWorkerAvailable: () => true,
				canLaunch: () => "daily budget exhausted",
			});
			const budgetResult = await budgetBlocked.execute(
				"x",
				{ task: "brief", worker: "small", tools: ["read"] },
				undefined,
				undefined,
				context(root),
			);
			expect(budgetResult.content[0]).toMatchObject({ text: expect.stringContaining("daily budget exhausted") });
			expect(budgetRunner).not.toHaveBeenCalled();
			const consultRunner = vi.fn(async () => ({
				model: "claude-cli/claude-fable-5",
				ok: true,
				text: "advice",
				latencyMs: 4,
			}));
			const consult = createConsultTool({
				getConfig: () => config,
				getCast: () => ({ primary: config.primary, mid: config.workers.mid, small: config.workers.small }),
				isEnabled: () => true,
				acquireSlot: () => undefined,
				delegateDir: () => root,
				recordUsage: (record) => records.push(record),
				runner,
				consultRunner,
				isWorkerAvailable: () => true,
			});
			await consult.execute("x", { question: "is this idiomatic?" }, undefined, undefined, context(root));
			expect(consultRunner).toHaveBeenCalledWith(config.consultants.fable, "is this idiomatic?", 1000, undefined);
			expect(records.at(-1)).toMatchObject({
				kind: "consult",
				advisor: "fable",
				costKnown: false,
				usage: { costTotal: 0 },
			});
		} finally {
			cleanup();
		}
	});
});
