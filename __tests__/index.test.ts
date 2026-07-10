import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, RegisteredCommand } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import piRouter, {
	_test,
	classifyPrompt,
	parseModelSpec,
	type RouterPanelRequest,
	resolveRouterConfig,
	runSubprocessPanel,
} from "../extensions/index.js";

beforeEach(() => {
	delete process.env.PI_ROUTER_ACTIVE;
	delete process.env.PI_ROUTER_ORCHESTRATE;
});

function tempWorkspace() {
	const root = mkdtempSync(join(tmpdir(), "pi-router-"));
	const cwd = join(root, "workspace");
	const home = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(home, { recursive: true });
	return { cwd, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function mockPi(flagValue = false) {
	const commands = new Map<string, Omit<RegisteredCommand, "name">>();
	const tools = new Map<string, unknown>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const events: unknown[] = [];
	return {
		commands,
		tools,
		handlers,
		events,
		pi: {
			registerFlag: vi.fn(),
			getFlag: vi.fn((name: string) => (name === _test.ROUTER_FLAG ? flagValue : undefined)),
			registerCommand: vi.fn((name: string, options: Omit<RegisteredCommand, "name">) => commands.set(name, options)),
			registerTool: vi.fn((tool: { name: string }) => tools.set(tool.name, tool)),
			on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				handlers.set(event, handler),
			),
			setModel: vi.fn(async () => true),
			getThinkingLevel: vi.fn(() => "off"),
			setThinkingLevel: vi.fn(),
			getActiveTools: vi.fn(() => ["read", "bash", "edit", "write"]),
			setActiveTools: vi.fn(),
			events: { emit: vi.fn((_name: string, data: unknown) => events.push(data)), on: vi.fn() },
		} as unknown as ExtensionAPI,
	};
}

function mockContext(
	cwd: string,
	models: Array<{ provider: string; id: string; oauth?: boolean; auth?: boolean }> = [],
	options: { signal?: AbortSignal } = {},
) {
	const current = models[0] ? { provider: models[0].provider, id: models[0].id } : undefined;
	return {
		cwd,
		model: current,
		modelRegistry: {
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			hasConfiguredAuth: (model: { auth?: boolean }) => model.auth !== false,
			isUsingOAuth: (model: { oauth?: boolean }) => model.oauth !== false,
		},
		signal: options.signal,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
	} as unknown as ExtensionContext;
}

describe("router helpers", () => {
	it("parses model specs with optional thinking", () => {
		expect(parseModelSpec("openai-codex/gpt-5.5:medium")).toEqual({
			provider: "openai-codex",
			id: "gpt-5.5",
			thinking: "medium",
		});
		expect(parseModelSpec("bad")).toBeUndefined();
	});

	it("classifies important buckets", () => {
		expect(classifyPrompt("fix the failing TypeScript tests")).toMatchObject({ route: "code", thinkingLevel: "high" });
		expect(classifyPrompt("investigate analytics report pipeline sources")).toMatchObject({
			route: "research",
			thinkingLevel: "high",
		});
		expect(classifyPrompt("write this in a cleaner style")).toMatchObject({ route: "write", thinkingLevel: "medium" });
		expect(classifyPrompt("hi", "fast")).toMatchObject({ route: "fast", thinkingLevel: "minimal" });
		expect(_test.DEFAULT_ROUTE_MODELS.write[0]).toBe("openai-codex/gpt-5.5:low");
		expect(_test.DEFAULT_ROUTE_MODELS.general[0]).toBe("openai-codex/gpt-5.5:low");
	});

	it("routes eval-style hard prompts to high-capability buckets", () => {
		expect(classifyPrompt("Inspect files, edit code, run npm test, and summarize.")).toMatchObject({
			route: "code",
			thinkingLevel: "high",
		});
		expect(classifyPrompt("How do I use pi's built-in /benchmark-models command?")).toMatchObject({
			route: "general",
			thinkingLevel: "medium",
		});
		expect(classifyPrompt("Summarize a fabricated article and include the publication date.")).toMatchObject({
			route: "general",
			thinkingLevel: "medium",
		});
		expect(
			classifyPrompt("Investigate deploy OAuth and provider gateway logs for a production cron health report."),
		).toMatchObject({ route: "research", thinkingLevel: "high" });
		expect(
			classifyPrompt(
				"A maintainer asks you to finish a repo change and merge it. What GitHub workflow rule must you follow?",
			),
		).toMatchObject({ route: "general", thinkingLevel: "medium" });
	});

	it("scores ambiguous routes and supports sticky follow-ups", () => {
		expect(classifyPrompt("Find citations and sources for this TypeScript build failure.")).toMatchObject({
			route: "research",
			rule: "research-keywords",
		});
		expect(classifyPrompt("Rewrite this API handler to reduce duplication.")).toMatchObject({
			route: "code",
			rule: "code-keywords",
		});
		const previous = classifyPrompt("fix the failing TypeScript tests");
		expect(classifyPrompt("continue", "balanced", {}, previous)).toMatchObject({
			route: "code",
			rule: "route-stickiness",
		});
	});

	it("de-escalates short low-risk code prompts", () => {
		const decision = classifyPrompt("Please make a one-line rename in this helper function.");
		expect(decision.route).toBe("code");
		expect(
			_test.applyCostControlledThinking("Please make a one-line rename in this helper function.", decision, "high"),
		).toBe("medium");
	});

	it("prefers project config over global config", () => {
		const { cwd, home, cleanup } = tempWorkspace();
		try {
			const paths = _test.getConfigPaths(cwd, home);
			mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(paths.globalConfigPath, JSON.stringify({ active: true, mode: "strong" }));
			writeFileSync(paths.projectConfigPath, JSON.stringify({ active: false, mode: "fast" }));
			const config = resolveRouterConfig(cwd, home);
			expect(config.active).toBe(false);
			expect(config.mode).toBe("fast");
			expect(config.configPath).toBe(paths.projectConfigPath);
		} finally {
			cleanup();
		}
	});

	it("routes configured extra keywords without changing default classification", () => {
		const { cwd, home, cleanup } = tempWorkspace();
		try {
			const paths = _test.getConfigPaths(cwd, home);
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				paths.projectConfigPath,
				JSON.stringify({ extraKeywords: { research: ["railway"], nope: ["ignored"], code: [1] } }),
			);
			const config = resolveRouterConfig(cwd, home);
			expect(classifyPrompt("railway queue", "balanced")).toMatchObject({ route: "general" });
			expect(classifyPrompt("railway queue", "balanced", config.extraKeywords)).toMatchObject({
				route: "research",
				signals: expect.arrayContaining(["extra:railway"]),
			});
			expect(config.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("Unknown route");
			expect(config.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
				"Expected a keyword string",
			);
		} finally {
			cleanup();
		}
	});

	it("warns on overlapping and stale extra keywords", () => {
		const lines = _test.extraKeywordDoctorLines(
			{ research: ["report"], code: ["bespoke"] },
			[
				{
					timestamp: "2026-06-20T12:00:00.000Z",
					kind: "turn",
					active: true,
					route: "code",
					signals: ["extra:bespoke"],
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					costTotal: 0,
				},
			],
			new Date("2026-06-28T12:00:00.000Z"),
		);
		expect(lines.join("\n")).toContain('extraKeywords.research "report" also matches built-in write route keywords');
		expect(lines.join("\n")).toContain('extraKeywords.research "report" has not fired');
		expect(lines.join("\n")).not.toContain('extraKeywords.code "bespoke" has not fired');
	});

	it("parses synthesis config and keeps it disabled by default", () => {
		const disabled = _test.parseSynthesisConfig();
		expect(disabled.enabled).toBe(false);
		expect(disabled.routes.reason).toBeUndefined();

		const enabled = _test.parseSynthesisConfig({
			enabled: true,
			routes: {
				reason: {
					strategy: "advisory-context",
					models: ["openai-codex/gpt-5.5:xhigh", "claude-cli/opus-4.8:medium", "bad"],
					timeoutMs: 1234,
					minPromptChars: 200,
					maxTotalChars: 3000,
					maxPanelists: 1,
				},
			},
		});
		expect(enabled.enabled).toBe(true);
		expect(enabled.routes.reason?.models).toHaveLength(2);
		expect(enabled.routes.reason?.timeoutMs).toBe(1234);
		expect(enabled.routes.reason?.minPromptChars).toBe(200);
		expect(enabled.routes.reason?.maxTotalChars).toBe(3000);
		expect(enabled.routes.reason?.maxPanelists).toBe(1);
	});

	it("reports config diagnostics and falls back from invalid route model specs", () => {
		const { cwd, home, cleanup } = tempWorkspace();
		try {
			const paths = _test.getConfigPaths(cwd, home);
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				paths.projectConfigPath,
				JSON.stringify({
					active: "true",
					unknown: true,
					mode: "balenced",
					routes: { code: ["bad"], nope: "openai-codex/gpt-5.5" },
					synthesis: { routes: { missing: { models: ["bad"] }, reason: { models: ["bad"] } } },
				}),
			);
			const config = resolveRouterConfig(cwd, home);
			expect(config.routes.code).toEqual(_test.DEFAULT_ROUTE_MODELS.code.map(parseModelSpec));
			expect(config.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("Unknown top-level key");
			expect(config.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("Unknown route");
			expect(config.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
				"No valid model specs found",
			);
			expect(config.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
				"Unknown synthesis route",
			);
		} finally {
			cleanup();
		}
	});

	it("adds route explainability and explicit guardrail tags", () => {
		expect(_test.analyzePrompt("fix the failing tests")).toMatchObject({
			route: "code",
			confidence: expect.any(Number),
			signals: ["code-or-repo"],
		});
		expect(_test.analyzePrompt("Summarize this fabricated article.")).toMatchObject({
			route: "general",
			guardrails: ["verification"],
		});
	});

	it("diagnoses model candidate availability", () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const ctx = mockContext(cwd, [
				{ provider: "openai-codex", id: "gpt-5.5", oauth: false },
				{ provider: "claude-cli", id: "opus-4.8", auth: false },
			]);
			const statuses = _test.diagnoseModelCandidates(
				ctx,
				[
					{ provider: "missing", id: "model" },
					{ provider: "claude-cli", id: "opus-4.8" },
					{ provider: "openai-codex", id: "gpt-5.5" },
				],
				true,
			);
			expect(statuses).toMatchObject([
				{ found: false, reason: "model not registered" },
				{ found: true, authenticated: false, reason: "no configured auth" },
				{ found: true, authenticated: true, oauth: false, reason: "not OAuth-backed" },
			]);
		} finally {
			cleanup();
		}
	});

	it("caps advisory context total length", () => {
		const context = _test.formatAdvisoryContext(
			[
				{ model: "a", ok: true, text: "x".repeat(200), latencyMs: 1 },
				{ model: "b", ok: true, text: "y".repeat(200), latencyMs: 1 },
			],
			{ route: "reason", thinkingLevel: "high", reason: "reasoning" },
			100,
		);
		expect(context).toContain("Router advisory synthesis context");
		expect(context?.length).toBeLessThan(600);
	});
});

describe("router extension", () => {
	it("defaults off and emits disabled telemetry", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "extensions", "router.json"), JSON.stringify({ active: false }));
			const { pi, handlers, events } = mockPi(false);
			piRouter(pi, { homeDir: cwd });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5" }]);
			await handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "fix tests" }, ctx);
			expect(events[0]).toMatchObject({ active: false });
			expect(pi.setModel).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("routes when --router flag is set", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const { pi, handlers, events } = mockPi(true);
			piRouter(pi, { homeDir: cwd, usageHistoryPath: join(cwd, "router-usage.jsonl") });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "fix failing tests", systemPrompt: "base" },
				ctx,
			);
			expect(pi.setModel).toHaveBeenCalled();
			expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
			expect(events.at(-1)).toMatchObject({ active: true, route: "code", selectedModel: "openai-codex/gpt-5.5" });
		} finally {
			cleanup();
		}
	});

	it("records assistant cost and exposes a cost command", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const { pi, handlers, commands, events } = mockPi(true);
			piRouter(pi, { homeDir: cwd });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "write this in a cleaner style", systemPrompt: "base" },
				ctx,
			);
			handlers.get("message_end")?.(
				{
					type: "message_end",
					message: {
						role: "assistant",
						provider: "openai-codex",
						model: "gpt-5.5",
						usage: {
							input: 100,
							output: 20,
							cacheRead: 50,
							cacheWrite: 10,
							totalTokens: 180,
							cost: { total: 0.012 },
						},
					},
				},
				ctx,
			);
			expect(events.at(-1)).toMatchObject({ route: "write", model: "openai-codex/gpt-5.5", costTotal: 0.012 });
			await commands.get(_test.ROUTER_COMMAND)?.handler("cost", ctx as never);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Router cost"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cacheRead=50"), "info");
		} finally {
			cleanup();
		}
	});

	it("persists enriched aggregate usage history and reports history", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const historyPath = join(cwd, "router-usage.jsonl");
			const { pi, handlers, commands } = mockPi(true);
			piRouter(pi, { homeDir: cwd, usageHistoryPath: historyPath, now: () => new Date("2026-06-28T12:00:00.000Z") });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "write this in a cleaner style", systemPrompt: "base" },
				ctx,
			);
			handlers.get("message_end")?.(
				{
					type: "message_end",
					message: {
						role: "assistant",
						provider: "openai-codex",
						model: "gpt-5.5",
						usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.02 } },
					},
				},
				ctx,
			);
			handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
			const record = JSON.parse(readFileSync(historyPath, "utf-8").trim());
			expect(record).toMatchObject({ route: "write", rule: "write-keywords", confidence: expect.any(Number) });
			expect(record.sessionId).toEqual(expect.any(String));
			await commands.get(_test.ROUTER_COMMAND)?.handler("cost history", ctx as never);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("2026-06-28"), "info");
			await commands.get(_test.ROUTER_COMMAND)?.handler("cost daily", ctx as never);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Router daily cost"), "info");
		} finally {
			cleanup();
		}
	});

	it("writes shadow route records without changing turn counts", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const historyPath = join(cwd, "router-usage.jsonl");
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "extensions", "router.json"), JSON.stringify({ active: true, shadowRoute: true }));
			const { pi, handlers } = mockPi(false);
			piRouter(pi, { homeDir: cwd, usageHistoryPath: historyPath, now: () => new Date("2026-06-28T12:00:00.000Z") });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "write this in a cleaner style", systemPrompt: "base" },
				ctx,
			);
			handlers.get("message_end")?.(
				{
					type: "message_end",
					message: {
						role: "assistant",
						provider: "openai-codex",
						model: "gpt-5.5",
						usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.02 } },
					},
				},
				ctx,
			);
			handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
			const records = readFileSync(historyPath, "utf-8")
				.trim()
				.split(/\r?\n/)
				.map((line) => JSON.parse(line));
			expect(records.find((record) => record.kind === "shadow")).toMatchObject({
				active: true,
				route: "write",
				shadowRoute: "write",
				shadowThinkingLevel: "minimal",
				shadowEstimatedCacheImpact: "same-family",
			});
			expect(_test.usageHistorySummary(records, new Date("2026-06-28T13:00:00.000Z")).join("\n")).toContain("turns=1");
		} finally {
			cleanup();
		}
	});

	it("excludes panel records from history turn counts", () => {
		const base = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };
		const lines = _test.usageHistorySummary(
			[
				{ timestamp: "2026-06-28T12:00:00.000Z", kind: "turn", ...base, input: 10, totalTokens: 10 },
				{ timestamp: "2026-06-28T12:00:05.000Z", kind: "panel", ...base },
				{ timestamp: "2026-06-28T12:00:06.000Z", kind: "panel", ...base },
			],
			new Date("2026-06-28T13:00:00.000Z"),
		);
		expect(lines.join("\n")).toContain("turns=1");
	});

	it("records opt-in misroute labels with prompt text", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const misroutePath = join(cwd, "misroutes.jsonl");
			const { pi, handlers, commands } = mockPi(true);
			piRouter(pi, {
				homeDir: cwd,
				misrouteHistoryPath: misroutePath,
				now: () => new Date("2026-06-28T12:00:00.000Z"),
			});
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "write this in a cleaner style", systemPrompt: "base" },
				ctx,
			);
			await commands.get(_test.ROUTER_COMMAND)?.handler("label code", ctx as never);
			const record = JSON.parse(readFileSync(misroutePath, "utf-8").trim());
			expect(record).toMatchObject({
				prompt: "write this in a cleaner style",
				wrongRoute: "write",
				correctRoute: "code",
				rule: "write-keywords",
			});
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Prompt stored locally"), "info");
		} finally {
			cleanup();
		}
	});

	it("records implicit use corrections after same-task follow-up", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const misroutePath = join(cwd, "misroutes.jsonl");
			const { pi, handlers, commands } = mockPi(true);
			piRouter(pi, {
				homeDir: cwd,
				misrouteHistoryPath: misroutePath,
				now: () => new Date("2026-06-28T12:00:00.000Z"),
			});
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "write this in a cleaner style", systemPrompt: "base" },
				ctx,
			);
			await commands.get(_test.ROUTER_COMMAND)?.handler("use code", ctx as never);
			expect(() => readFileSync(misroutePath, "utf-8")).toThrow();
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "rewrite this same helper in a cleaner style", systemPrompt: "base" },
				ctx,
			);
			const record = JSON.parse(readFileSync(misroutePath, "utf-8").trim());
			expect(record).toMatchObject({
				source: "implicit-use",
				prompt: "write this in a cleaner style",
				wrongRoute: "write",
				correctRoute: "code",
				wrongThinkingLevel: "low",
			});
		} finally {
			cleanup();
		}
	});

	it("skips implicit use corrections before dissimilar new tasks", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const misroutePath = join(cwd, "misroutes.jsonl");
			const { pi, handlers, commands } = mockPi(true);
			piRouter(pi, { homeDir: cwd, misrouteHistoryPath: misroutePath });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "write this in a cleaner style", systemPrompt: "base" },
				ctx,
			);
			await commands.get(_test.ROUTER_COMMAND)?.handler("use code", ctx as never);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "research railway deployment logs", systemPrompt: "base" },
				ctx,
			);
			expect(() => readFileSync(misroutePath, "utf-8")).toThrow();
		} finally {
			cleanup();
		}
	});

	it("records implicit effort corrections with corrected thinking level", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const misroutePath = join(cwd, "misroutes.jsonl");
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "extensions", "router.json"), JSON.stringify({ active: true }));
			const { pi, handlers, commands } = mockPi(false);
			piRouter(pi, { homeDir: cwd, misrouteHistoryPath: misroutePath });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "Tell me something useful about routers.", systemPrompt: "base" },
				ctx,
			);
			await commands.get(_test.ROUTER_COMMAND)?.handler("effort current high", ctx as never);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "continue", systemPrompt: "base" },
				ctx,
			);
			const record = JSON.parse(readFileSync(misroutePath, "utf-8").trim());
			expect(record).toMatchObject({
				source: "implicit-effort",
				wrongRoute: "general",
				correctRoute: "general",
				wrongThinkingLevel: "low",
				correctThinkingLevel: "high",
			});
		} finally {
			cleanup();
		}
	});

	it("emits soft budget alerts and reports budget status", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "extensions", "router.json"),
				JSON.stringify({ active: true, costControls: { sessionBudgetUsd: 0.01, warnAtPct: 0.5 } }),
			);
			const { pi, handlers, commands, events } = mockPi(false);
			piRouter(pi, { homeDir: cwd, usageHistoryPath: join(cwd, "router-usage.jsonl") });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "write this in a cleaner style", systemPrompt: "base" },
				ctx,
			);
			handlers.get("message_end")?.(
				{
					type: "message_end",
					message: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.02 } } },
				},
				ctx,
			);
			expect(events.some((event) => (event as { type?: string }).type === "budget")).toBe(true);
			await commands.get(_test.ROUTER_COMMAND)?.handler("cost", ctx as never);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("over budget"), "info");
		} finally {
			cleanup();
		}
	});

	it("gates synthesis when budget state is over limit", () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "extensions", "router.json"),
				JSON.stringify({
					active: true,
					costControls: { synthesisMinPromptChars: 40, disableSynthesisOverBudget: true },
					synthesis: {
						enabled: true,
						routes: { reason: { models: ["openai-codex/gpt-5.5:xhigh"], minPromptChars: 40 } },
					},
				}),
			);
			const config = resolveRouterConfig(cwd);
			const decision = classifyPrompt("Compare the architecture tradeoffs and risk in detail.");
			expect(
				_test.shouldRunSynthesis(decision, config, "Compare the architecture tradeoffs and risk in detail."),
			).toBeTruthy();
			expect(
				_test.shouldRunSynthesis(decision, config, "Compare the architecture tradeoffs and risk in detail.", {
					budgetOver: true,
				}),
			).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("keeps live smoke opt-in", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const previous = process.env.PI_ROUTER_LIVE;
			delete process.env.PI_ROUTER_LIVE;
			const { pi, commands } = mockPi(false);
			const panelRunner = vi.fn(async () => []);
			piRouter(pi, { homeDir: cwd, panelRunner });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await commands.get(_test.ROUTER_COMMAND)?.handler("smoke", ctx as never);
			expect(panelRunner).not.toHaveBeenCalled();
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("opt-in"), "warning");
			if (previous === undefined) delete process.env.PI_ROUTER_LIVE;
			else process.env.PI_ROUTER_LIVE = previous;
		} finally {
			cleanup();
		}
	});

	it("escalates guardrail prompts above cheap general defaults", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const { pi, handlers } = mockPi(true);
			piRouter(pi, { homeDir: cwd });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "Summarize this fabricated article.", systemPrompt: "base" },
				ctx,
			);
			expect(pi.setThinkingLevel).toHaveBeenCalledWith("medium");
		} finally {
			cleanup();
		}
	});

	it("prefers the current model when cache preference is enabled", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "extensions", "router.json"),
				JSON.stringify({
					active: true,
					costControls: { preferCache: true },
					routes: {
						general: ["openai-codex/gpt-5.5:low", "claude-cli/opus-4.8:medium"],
					},
				}),
			);
			const { pi, handlers } = mockPi(false);
			piRouter(pi, { homeDir: cwd });
			const ctx = mockContext(cwd, [
				{ provider: "claude-cli", id: "opus-4.8", oauth: true },
				{ provider: "openai-codex", id: "gpt-5.5", oauth: true },
			]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "Tell me something useful about routers.", systemPrompt: "base" },
				ctx,
			);
			expect(pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude-cli" }));
		} finally {
			cleanup();
		}
	});

	it("applies route tool profiles without enabling disabled tools and restores them", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "extensions", "router.json"),
				JSON.stringify({ active: true, toolProfiles: { general: ["read", "bash", "write"] } }),
			);
			const { pi, handlers } = mockPi(false);
			(pi.getActiveTools as ReturnType<typeof vi.fn>).mockReturnValue(["read", "bash"]);
			piRouter(pi, { homeDir: cwd });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "Tell me something useful about routers.", systemPrompt: "base" },
				ctx,
			);
			expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
			handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
			expect(pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"]);
		} finally {
			cleanup();
		}
	});

	it("updates route effort through the router command", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "extensions", "router.json"), JSON.stringify({ active: true }));
			const { pi, handlers, commands } = mockPi(false);
			piRouter(pi, { homeDir: cwd, usageHistoryPath: join(cwd, "router-usage.jsonl") });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await commands.get(_test.ROUTER_COMMAND)?.handler("effort general high", ctx as never);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "Tell me something useful about routers.", systemPrompt: "base" },
				ctx,
			);
			expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
		} finally {
			cleanup();
		}
	});

	it("runs configured advisory synthesis and injects system prompt context", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "extensions", "router.json"),
				JSON.stringify({
					active: true,
					costControls: { synthesisMinPromptChars: 40 },
					synthesis: {
						enabled: true,
						routes: {
							reason: { models: ["openai-codex/gpt-5.5:xhigh"], timeoutMs: 1000, minPromptChars: 40 },
						},
					},
				}),
			);
			const { pi, handlers, events } = mockPi(false);
			const historyPath = join(cwd, "router-usage.jsonl");
			const controller = new AbortController();
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }], {
				signal: controller.signal,
			});
			const panelRunner = vi.fn(async (request: RouterPanelRequest) => {
				expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-router", "Routing: consulting advisory panel…");
				return [
					{
						model: "openai-codex/gpt-5.5:xhigh",
						ok: true,
						text: `panel for ${request.decision.route}`,
						latencyMs: 5,
					},
				];
			});
			piRouter(pi, { homeDir: cwd, panelRunner, usageHistoryPath: historyPath });
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			const result = await handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt: "Compare the architecture tradeoffs for this router synthesis approach in detail.",
					systemPrompt: "base system",
				},
				ctx,
			);
			expect(panelRunner).toHaveBeenCalledOnce();
			expect(panelRunner).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
			expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-router", undefined);
			expect(result).toMatchObject({ systemPrompt: expect.stringContaining("Router advisory synthesis context") });
			expect(result).toMatchObject({ systemPrompt: expect.stringContaining("panel for reason") });
			expect(events.some((event) => (event as { okCount?: number }).okCount === 1)).toBe(true);
			expect(events.at(-1)).toMatchObject({ active: true, route: "reason", panelActive: true, panelOkCount: 1 });
			handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
			expect(readFileSync(historyPath, "utf-8")).toContain('"kind":"panel"');
		} finally {
			cleanup();
		}
	});

	it("fails open when advisory synthesis has no successful panelists", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "extensions", "router.json"),
				JSON.stringify({
					active: true,
					costControls: { synthesisMinPromptChars: 40 },
					synthesis: {
						enabled: true,
						routes: { reason: { models: ["openai-codex/gpt-5.5:xhigh"], minPromptChars: 40 } },
					},
				}),
			);
			const { pi, handlers, events } = mockPi(false);
			const panelRunner = vi.fn(async () => [
				{ model: "openai-codex/gpt-5.5:xhigh", ok: false, text: "timeout", diagnostic: "timeout", latencyMs: 50 },
			]);
			piRouter(pi, { homeDir: cwd, panelRunner, usageHistoryPath: join(cwd, "router-usage.jsonl") });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			const result = await handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt: "Why is this root cause analysis risky and what tradeoffs matter most?",
					systemPrompt: "base system",
				},
				ctx,
			);
			expect(panelRunner).toHaveBeenCalledOnce();
			expect(result).toBeUndefined();
			expect(pi.setModel).toHaveBeenCalled();
			expect(events.at(-1)).toMatchObject({
				active: true,
				route: "reason",
				panelActive: true,
				panelOkCount: 0,
				panelFailCount: 1,
			});
		} finally {
			cleanup();
		}
	});

	it("cancels subprocess advisory panelists when the abort signal fires", async () => {
		const { cwd, cleanup } = tempWorkspace();
		const previousPiBin = process.env.PI_BIN;
		try {
			const scriptPath = join(cwd, "slow-panel.sh");
			writeFileSync(scriptPath, "#!/usr/bin/env bash\nsleep 10\n");
			chmodSync(scriptPath, 0o755);
			process.env.PI_BIN = scriptPath;
			const controller = new AbortController();
			const promise = runSubprocessPanel({
				prompt: "Compare architecture tradeoffs in detail.",
				decision: {
					route: "reason",
					thinkingLevel: "high",
					reason: "test",
					signals: ["reasoning"],
					confidence: 1,
				},
				spec: {
					strategy: "advisory-context",
					models: [{ provider: "openai-codex", id: "gpt-5.5", thinking: "xhigh" }],
					timeoutMs: 5000,
					maxPromptChars: 1000,
					minPromptChars: 1,
					maxTotalChars: 1000,
					maxPanelists: 1,
				},
				signal: controller.signal,
			});
			controller.abort();
			const [result] = await promise;
			expect(result).toMatchObject({ ok: false, diagnostic: "cancelled by abort signal" });
		} finally {
			if (previousPiBin === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = previousPiBin;
			cleanup();
		}
	});

	it("adds guardrail context for explicit verification decisions", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "extensions", "router.json"), JSON.stringify({ active: true }));
			const { pi, handlers } = mockPi(false);
			piRouter(pi, { homeDir: cwd });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "Summarize this fabricated article.", systemPrompt: "base" },
				ctx,
			);
			const event = { messages: [{ role: "user", content: "Summarize this fabricated article." }] };
			handlers.get("context")?.(event, ctx);
			expect(event.messages.at(-1)).toMatchObject({ customType: "router.guardrail" });
		} finally {
			cleanup();
		}
	});

	it("prints router doctor diagnostics", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "extensions", "router.json"), JSON.stringify({ mode: "bad" }));
			const { pi, commands } = mockPi(false);
			piRouter(pi, { homeDir: cwd });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await commands.get(_test.ROUTER_COMMAND)?.handler("doctor", ctx as never);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Router doctor"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Diagnostics:"), "info");
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Routes:"), "info");
		} finally {
			cleanup();
		}
	});

	it("does not clobber routes or synthesis when persisting state", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const configPath = join(cwd, ".pi", "extensions", "router.json");
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				configPath,
				JSON.stringify({
					active: false,
					routes: { code: ["bad"] },
					synthesis: { enabled: true, routes: { reason: { models: ["bad"] } } },
				}),
			);
			const { pi, commands } = mockPi(false);
			piRouter(pi, { homeDir: cwd });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await commands.get(_test.ROUTER_COMMAND)?.handler("auto on", ctx as never);
			const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(persisted.routes.code).toEqual(["bad"]);
			expect(persisted.synthesis.routes.reason.models).toEqual(["bad"]);
			expect(persisted.active).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("honors synthesis minPromptChars", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "extensions", "router.json"),
				JSON.stringify({
					active: true,
					synthesis: {
						enabled: true,
						routes: { reason: { models: ["openai-codex/gpt-5.5:xhigh"], minPromptChars: 500 } },
					},
				}),
			);
			const { pi, handlers } = mockPi(false);
			const panelRunner = vi.fn(async () => [
				{ model: "openai-codex/gpt-5.5:xhigh", ok: true, text: "panel", latencyMs: 5 },
			]);
			piRouter(pi, { homeDir: cwd, panelRunner });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt: "Why is this root cause analysis risky and what tradeoffs matter most?",
					systemPrompt: "base system",
				},
				ctx,
			);
			expect(panelRunner).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("pins the orchestration primary and persists orchestration controls", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const configPath = join(cwd, ".pi", "extensions", "router.json");
			mkdirSync(dirname(configPath), { recursive: true });
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
			writeFileSync(configPath, JSON.stringify({ orchestration: { enabled: true, pool: "scoped" } }));
			const { pi, handlers, commands, events } = mockPi(false);
			piRouter(pi, { homeDir: cwd });
			const ctx = mockContext(cwd, [
				{ provider: "openai-codex", id: "gpt-5.6", oauth: true },
				{ provider: "openai-codex", id: "gpt-5.6-sol", oauth: true },
				{ provider: "openai-codex", id: "gpt-5.5", oauth: true },
			]);
			await handlers.get("session_start")?.({ type: "session_start" }, ctx);
			expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "edit", "write", "delegate", "consult"]);
			const result = await handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "fix the failing TypeScript tests", systemPrompt: "base" },
				ctx,
			);
			expect(pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "gpt-5.6" }));
			expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
			expect(result).toMatchObject({ systemPrompt: expect.stringContaining("Router orchestration charter") });
			expect(result).toMatchObject({ systemPrompt: expect.stringContaining("Router hint: route=code") });
			expect(events.at(-1)).toMatchObject({ orchestrated: true, selectedModel: "openai-codex/gpt-5.6" });
			(pi.getActiveTools as ReturnType<typeof vi.fn>).mockReturnValue([
				"read",
				"bash",
				"edit",
				"write",
				"delegate",
				"consult",
			]);
			await commands.get(_test.ROUTER_COMMAND)?.handler("orchestrate off", ctx as never);
			expect(pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "edit", "write"]);
			expect(JSON.parse(readFileSync(configPath, "utf-8")).orchestration.enabled).toBe(false);
			await commands.get(_test.ROUTER_COMMAND)?.handler("doctor", ctx as never);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Delegate directory:"), "info");
		} finally {
			cleanup();
		}
	});

	it("falls back to keyword routing only when router auto is active and the orchestration primary is unavailable", async () => {
		const { cwd, cleanup } = tempWorkspace();
		try {
			const configPath = join(cwd, ".pi", "extensions", "router.json");
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, JSON.stringify({ orchestration: { enabled: true } }));
			const inactive = mockPi(false);
			piRouter(inactive.pi, { homeDir: cwd });
			const ctx = mockContext(cwd, [{ provider: "openai-codex", id: "gpt-5.5", oauth: true }]);
			await inactive.handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await inactive.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "fix the failing TypeScript tests", systemPrompt: "base" },
				ctx,
			);
			expect(inactive.pi.setModel).not.toHaveBeenCalled();
			expect(inactive.events.at(-1)).toMatchObject({ active: false });

			writeFileSync(configPath, JSON.stringify({ active: true, orchestration: { enabled: true } }));
			const active = mockPi(false);
			piRouter(active.pi, { homeDir: cwd });
			await active.handlers.get("session_start")?.({ type: "session_start" }, ctx);
			await active.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "fix the failing TypeScript tests", systemPrompt: "base" },
				ctx,
			);
			expect(active.pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "gpt-5.5" }));
			expect(active.events.at(-1)).toMatchObject({ active: true, route: "code" });
			expect(active.events.at(-1)).not.toHaveProperty("orchestrated");
		} finally {
			cleanup();
		}
	});
});
