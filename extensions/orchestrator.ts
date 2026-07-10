import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export type OrchestrationWorker = "mid" | "small";

export interface RouterModelSpec {
	provider: string;
	id: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface ResolvedOrchestrationConfig {
	enabled: boolean;
	primary: RouterModelSpec;
	workers: Record<OrchestrationWorker, RouterModelSpec>;
	pool?: RouterModelSpec[];
	poolSource?: "scoped" | "explicit";
	explicit: { primary: boolean; mid: boolean; small: boolean };
	consultants: { fable: RouterModelSpec };
	delegateTimeoutMs: number;
	consultTimeoutMs: number;
	maxConcurrent: number;
	maxOutputChars: number;
}

export interface OrchestrationCast {
	primary: RouterModelSpec;
	mid: RouterModelSpec;
	small: RouterModelSpec;
}

export interface DelegateUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
}

export interface DelegateResult {
	ok: boolean;
	text: string;
	filesTouched: string[];
	usage: DelegateUsage;
	costKnown?: boolean;
	latencyMs: number;
	diagnostic?: string;
}

export interface DelegateRequest {
	spec: RouterModelSpec;
	task: string;
	tools: string[];
	sessionPath: string;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onEvent?: (message: string) => void;
}

export type DelegateRunner = (request: DelegateRequest) => Promise<DelegateResult>;

export interface ConsultResult {
	model: string;
	ok: boolean;
	text: string;
	latencyMs: number;
	diagnostic?: string;
	usage?: DelegateUsage;
	costKnown?: boolean;
}

export type ConsultRunner = (
	spec: RouterModelSpec,
	prompt: string,
	timeoutMs: number,
	signal?: AbortSignal,
) => Promise<ConsultResult>;

const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const delegateParameters = Type.Object({
	task: Type.String({ minLength: 1 }),
	worker: Type.Union([Type.Literal("mid"), Type.Literal("small")]),
	tools: Type.Array(Type.Union(WORKER_TOOLS.map((tool) => Type.Literal(tool))), { minItems: 1 }),
	continueId: Type.Optional(Type.String({ pattern: "^[a-z0-9-]+$" })),
	expectation: Type.Optional(Type.String()),
});
const consultParameters = Type.Object({
	question: Type.String({ minLength: 1 }),
	advisor: Type.Optional(Type.Literal("fable")),
	context: Type.Optional(Type.String()),
});
const WORKER_PREAMBLE =
	"Complete only the brief below. You cannot see the orchestrator's conversation. End with a concise report: what you did, files changed, and what you could not verify.";
const MAX_BUFFER = 1024 * 1024;

function modelKey(spec: RouterModelSpec): string {
	return `${spec.provider}/${spec.id}${spec.thinking ? `:${spec.thinking}` : ""}`;
}

function textContent(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function usageFrom(value: unknown): DelegateUsage {
	const usage = typeof value === "object" && value !== null ? value : {};
	const cost =
		typeof (usage as { cost?: unknown }).cost === "object" && (usage as { cost?: unknown }).cost !== null
			? (usage as { cost: Record<string, unknown> }).cost
			: {};
	return {
		input: typeof (usage as Record<string, unknown>).input === "number" ? (usage as Record<string, number>).input : 0,
		output:
			typeof (usage as Record<string, unknown>).output === "number" ? (usage as Record<string, number>).output : 0,
		cacheRead:
			typeof (usage as Record<string, unknown>).cacheRead === "number"
				? (usage as Record<string, number>).cacheRead
				: 0,
		cacheWrite:
			typeof (usage as Record<string, unknown>).cacheWrite === "number"
				? (usage as Record<string, number>).cacheWrite
				: 0,
		totalTokens:
			typeof (usage as Record<string, unknown>).totalTokens === "number"
				? (usage as Record<string, number>).totalTokens
				: 0,
		costTotal: typeof (cost as Record<string, unknown>).total === "number" ? (cost as Record<string, number>).total : 0,
	};
}

function addUsage(total: DelegateUsage, usage: DelegateUsage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	total.costTotal += usage.costTotal;
}

function messageText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	return value
		.map((part) =>
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("");
}

export function buildDelegateArgs(spec: RouterModelSpec, task: string, tools: string[], sessionPath: string): string[] {
	return [
		"--mode",
		"json",
		"-p",
		"--provider",
		spec.provider,
		"--model",
		spec.id,
		...(spec.thinking ? ["--thinking", spec.thinking] : []),
		"--tools",
		tools.join(","),
		"--no-extensions",
		"--no-context-files",
		"--session",
		sessionPath,
		"--append-system-prompt",
		WORKER_PREAMBLE,
		task,
	];
}

interface DelegateWorkspace {
	cwd: string;
	isolated: boolean;
	setupDiagnostic?: string;
	finalize: (applyChanges: boolean) => { filesTouched: string[]; diagnostic?: string };
}

function git(cwd: string, args: string[], encoding: BufferEncoding = "utf-8"): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function prepareDelegateWorkspace(request: DelegateRequest): DelegateWorkspace {
	const mutating = request.tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write");
	if (!mutating) return { cwd: request.cwd, isolated: false, finalize: () => ({ filesTouched: [] }) };
	let repoRoot: string;
	try {
		repoRoot = git(request.cwd, ["rev-parse", "--show-toplevel"]).trim();
	} catch {
		return {
			cwd: request.cwd,
			isolated: false,
			setupDiagnostic:
				"mutating delegates require a git worktree, but the current directory is not in a git repository",
			finalize: () => ({ filesTouched: [] }),
		};
	}
	const sessionDirectory = dirname(request.sessionPath);
	const sessionInsideRepo = !relative(repoRoot, sessionDirectory).startsWith("..");
	const worktreeBase = sessionInsideRepo
		? join(dirname(repoRoot), ".pi-router-worktrees")
		: join(sessionDirectory, "worktrees");
	const worktreeRoot = join(worktreeBase, basename(request.sessionPath, ".jsonl"));
	const patchPath = `${request.sessionPath}.patch`;
	try {
		mkdirSync(dirname(worktreeRoot), { recursive: true });
		try {
			git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);
		} catch {}
		git(repoRoot, ["worktree", "add", "--detach", worktreeRoot, "HEAD"]);
		const trackedPatch = git(repoRoot, ["diff", "--binary", "HEAD"]);
		if (trackedPatch) {
			const baselinePatch = `${request.sessionPath}.baseline.patch`;
			writeFileSync(baselinePatch, trackedPatch);
			git(worktreeRoot, ["apply", baselinePatch]);
			rmSync(baselinePatch, { force: true });
		}
		const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
		for (const file of untracked) {
			const target = join(worktreeRoot, file);
			mkdirSync(dirname(target), { recursive: true });
			cpSync(join(repoRoot, file), target, { recursive: true });
		}
		git(worktreeRoot, ["add", "-A"]);
		git(worktreeRoot, [
			"-c",
			"user.name=pi-router",
			"-c",
			"user.email=pi-router@localhost",
			"commit",
			"--allow-empty",
			"-m",
			"pi-router delegate baseline",
		]);
		const baseline = git(worktreeRoot, ["rev-parse", "HEAD"]).trim();
		const subdir = relative(repoRoot, request.cwd);
		return {
			cwd: subdir && subdir !== "." ? join(worktreeRoot, subdir) : worktreeRoot,
			isolated: true,
			finalize: (applyChanges) => {
				let filesTouched: string[] = [];
				let diagnostic: string | undefined;
				try {
					git(worktreeRoot, ["add", "-N", "."]);
					filesTouched = git(worktreeRoot, ["diff", "--name-only", baseline]).split(/\r?\n/).filter(Boolean);
					const patch = git(worktreeRoot, ["diff", "--binary", baseline]);
					if (patch) {
						writeFileSync(patchPath, patch);
						if (applyChanges) {
							try {
								git(repoRoot, ["apply", "--check", patchPath]);
								git(repoRoot, ["apply", patchPath]);
							} catch (error) {
								diagnostic = `worker patch could not be applied; preserved at ${patchPath}: ${error instanceof Error ? error.message : String(error)}`;
							}
						} else {
							diagnostic = `worker did not complete; unapplied patch preserved at ${patchPath}`;
						}
					}
				} catch (error) {
					diagnostic = `failed to collect isolated worker changes: ${error instanceof Error ? error.message : String(error)}`;
				} finally {
					try {
						git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);
					} catch {}
				}
				return { filesTouched, diagnostic };
			},
		};
	} catch (error) {
		try {
			git(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);
		} catch {}
		return {
			cwd: request.cwd,
			isolated: false,
			setupDiagnostic: `failed to create isolated delegate worktree: ${error instanceof Error ? error.message : String(error)}`,
			finalize: () => ({ filesTouched: [] }),
		};
	}
}

export function runDelegate(request: DelegateRequest): Promise<DelegateResult> {
	const started = Date.now();
	const usage: DelegateUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };
	if (request.signal?.aborted)
		return Promise.resolve({
			ok: false,
			text: "cancelled by abort signal",
			filesTouched: [],
			usage,
			costKnown: false,
			latencyMs: 0,
			diagnostic: "cancelled by abort signal",
		});
	const workspace = prepareDelegateWorkspace(request);
	if (workspace.setupDiagnostic) {
		return Promise.resolve({
			ok: false,
			text: workspace.setupDiagnostic,
			filesTouched: [],
			usage,
			costKnown: false,
			latencyMs: Date.now() - started,
			diagnostic: workspace.setupDiagnostic,
		});
	}
	return new Promise((resolve) => {
		let settled = false;
		let bytes = 0;
		let lastText = "";
		let usageObserved = false;
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		const filesTouched = new Set<string>();
		const child = spawn(
			process.env.PI_BIN || "pi",
			buildDelegateArgs(request.spec, request.task, request.tools, request.sessionPath),
			{
				cwd: workspace.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const finish = (ok: boolean, diagnostic?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			request.signal?.removeEventListener("abort", abort);
			const finalized = workspace.finalize(ok);
			const finalDiagnostic = [diagnostic, finalized.diagnostic].filter(Boolean).join("; ") || undefined;
			resolve({
				ok: ok && !finalized.diagnostic,
				text: lastText || finalDiagnostic || "Worker returned no report.",
				filesTouched: workspace.isolated ? finalized.filesTouched : [...filesTouched],
				usage,
				costKnown: usageObserved,
				latencyMs: Date.now() - started,
				diagnostic: finalDiagnostic,
			});
		};
		const terminate = () => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		};
		const abort = () => {
			aborted = true;
			terminate();
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, request.timeoutMs);
		request.signal?.addEventListener("abort", abort, { once: true });
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			bytes += Buffer.byteLength(line) + 1;
			if (bytes > MAX_BUFFER * 8) {
				errorMessage = "worker output exceeded limit";
				terminate();
				return;
			}
			try {
				const event = JSON.parse(line) as Record<string, unknown>;
				if (event.type === "message_end") {
					const message = event.message as Record<string, unknown> | undefined;
					if (message?.role === "assistant") {
						const messageUsage =
							typeof message.usage === "object" && message.usage !== null
								? (message.usage as { cost?: unknown })
								: undefined;
						const messageCost =
							typeof messageUsage?.cost === "object" && messageUsage.cost !== null
								? (messageUsage.cost as { total?: unknown })
								: undefined;
						if (typeof messageCost?.total === "number") usageObserved = true;
						addUsage(usage, usageFrom(message.usage));
						lastText = messageText(message.content) ?? lastText;
						stopReason = typeof message.stopReason === "string" ? message.stopReason : stopReason;
						errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : errorMessage;
					}
				}
				if (event.type === "tool_execution_start") {
					const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
					request.onEvent?.(`Worker: ${toolName}`);
					const args = event.args as { path?: unknown } | undefined;
					if ((toolName === "edit" || toolName === "write") && typeof args?.path === "string")
						filesTouched.add(args.path);
				}
			} catch {}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk}`;
		});
		child.on("error", (error) => finish(false, error.message));
		child.on("close", (code) => {
			const diagnostic = aborted
				? "cancelled by abort signal"
				: timedOut
					? "worker timed out"
					: errorMessage ||
						(stopReason === "error" || stopReason === "aborted" ? stopReason : undefined) ||
						(code === 0 ? undefined : `worker exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
			finish(!diagnostic, diagnostic);
		});
	});
}

export function delegateDirectory(homeDir: string): string {
	return join(homeDir, ".pi", "agent", "extensions", "router-delegates");
}

export function pruneDelegateSessions(directory: string): number {
	if (!existsSync(directory)) return 0;
	const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
	let removed = 0;
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		try {
			if (statSync(path).mtimeMs < cutoff) {
				rmSync(path, { force: true, recursive: true });
				removed += 1;
			}
		} catch {}
	}
	return removed;
}

export interface DelegateActivityEvent {
	phase: "start" | "progress" | "finish";
	delegateId: string;
	worker: OrchestrationWorker;
	model: string;
	task: string;
	message?: string;
	ok?: boolean;
}

interface ToolDeps {
	getConfig: () => ResolvedOrchestrationConfig;
	getCast: (ctx: ExtensionContext) => OrchestrationCast;
	isEnabled: () => boolean;
	acquireSlot: () => (() => void) | undefined;
	delegateDir: () => string;
	recordUsage: (record: {
		kind: "delegate" | "consult";
		model: string;
		usage: DelegateUsage;
		ok: boolean;
		latencyMs: number;
		delegateId?: string;
		worker?: OrchestrationWorker;
		advisor?: string;
		costKnown?: boolean;
	}) => void;
	runner: DelegateRunner;
	consultRunner?: ConsultRunner;
	isWorkerAvailable: (ctx: ExtensionContext, spec: RouterModelSpec) => boolean;
	canLaunch?: (kind: "delegate" | "consult") => string | undefined;
	onDelegateActivity?: (event: DelegateActivityEvent, ctx: ExtensionContext) => void;
}

export function createDelegateTool(deps: ToolDeps): ToolDefinition<typeof delegateParameters> {
	return {
		name: "delegate",
		label: "Delegate work",
		description:
			"Delegate a self-contained task; the primary chooses small for narrow work or mid for nuanced multi-file work.",
		promptSnippet: "delegate: choose mid or small, then assign a self-contained brief",
		promptGuidelines: [
			"Choose the worker tier yourself: small for narrow search/verification/simple edits; mid for nuanced or multi-file work.",
			"Delegate only self-contained work, use the minimum tools, and review every worker report.",
		],
		parameters: delegateParameters,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!deps.isEnabled())
				return textContent("Delegation is disabled; do the work yourself, don't retry.", { ok: false });
			const budgetBlock = deps.canLaunch?.("delegate");
			if (budgetBlock) return textContent(`Delegation blocked: ${budgetBlock}`, { ok: false });
			const release = deps.acquireSlot();
			if (!release)
				return textContent("Delegation concurrency limit reached; do the work yourself or retry later.", { ok: false });
			try {
				const config = deps.getConfig();
				const spec = deps.getCast(ctx)[params.worker];
				if (!deps.isWorkerAvailable(ctx, spec))
					return textContent(`Worker model ${modelKey(spec)} is unavailable; do the work yourself.`, { ok: false });
				const directory = deps.delegateDir();
				mkdirSync(directory, { recursive: true });
				if (params.continueId && !existsSync(join(directory, `${params.continueId}.jsonl`)))
					return textContent("Unknown delegate continueId; do the work yourself, don't retry.", { ok: false });
				const delegateId =
					params.continueId ?? `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
				const activity = {
					delegateId,
					worker: params.worker,
					model: modelKey(spec),
					task: params.task,
				};
				deps.onDelegateActivity?.({ phase: "start", ...activity }, ctx);
				const result = await deps.runner({
					spec,
					task: params.task,
					tools: params.tools,
					sessionPath: join(directory, `${delegateId}.jsonl`),
					cwd: ctx.cwd || process.cwd(),
					timeoutMs: config.delegateTimeoutMs,
					signal,
					onEvent: (message) => {
						onUpdate?.(textContent(message, { delegateId }));
						deps.onDelegateActivity?.({ phase: "progress", message, ...activity }, ctx);
					},
				});
				deps.onDelegateActivity?.({ phase: "finish", ok: result.ok, ...activity }, ctx);
				deps.recordUsage({
					kind: "delegate",
					model: modelKey(spec),
					usage: result.usage,
					ok: result.ok,
					latencyMs: result.latencyMs,
					delegateId,
					worker: params.worker,
					costKnown: result.costKnown ?? false,
				});
				const report =
					result.text.length > config.maxOutputChars ? `${result.text.slice(0, config.maxOutputChars)}…` : result.text;
				const footer = `delegateId=${delegateId} | files=${result.filesTouched.join(",") || "none"} | cost=$${result.usage.costTotal.toFixed(4)} | model=${modelKey(spec)}`;
				return textContent(
					`${report}\n\n${footer}${params.expectation ? `\nExpectation: ${params.expectation}` : ""}`,
					{ ...result, delegateId, worker: params.worker },
				);
			} finally {
				release();
			}
		},
	};
}

export function createConsultTool(deps: ToolDeps): ToolDefinition<typeof consultParameters> {
	return {
		name: "consult",
		label: "Consult advisor",
		description: "Ask the read-only Fable advisor a question when the user explicitly requests it.",
		promptSnippet: "consult: ask Fable for an advisory-only opinion",
		promptGuidelines: ["Use consult only when the user explicitly asks for Fable; advisors have no repo access."],
		parameters: consultParameters,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			if (!deps.isEnabled())
				return textContent("Consultation is disabled; do the work yourself, don't retry.", { ok: false });
			const budgetBlock = deps.canLaunch?.("consult");
			if (budgetBlock) return textContent(`Consultation blocked: ${budgetBlock}`, { ok: false });
			if (!deps.consultRunner)
				return textContent("Consultation runner is unavailable; do the work yourself.", { ok: false });
			const config = deps.getConfig();
			const spec = config.consultants.fable;
			const prompt = `${params.question}${params.context ? `\n\nContext (the advisor has no repo access):\n${params.context}` : ""}`;
			const result = await deps.consultRunner(spec, prompt, config.consultTimeoutMs, signal);
			deps.recordUsage({
				kind: "consult",
				model: modelKey(spec),
				usage: result.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 },
				ok: result.ok,
				latencyMs: result.latencyMs,
				advisor: params.advisor ?? "fable",
				costKnown: result.costKnown ?? Boolean(result.usage),
			});
			return textContent(result.text, { ...result, advisor: params.advisor ?? "fable" });
		},
	};
}
