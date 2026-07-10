import { execFile } from "node:child_process";
import type { RouterDecision, RouterModelSpec, RouterPanelRequest, RouterPanelResult } from "./index.js";
import type { DelegateUsage } from "./orchestrator.js";

const DEFAULT_PANEL_MAX_PROMPT_CHARS = 6000;
const DEFAULT_PANEL_MAX_TOTAL_CHARS = 12_000;
const PANEL_MAX_BUFFER = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelSpecKey(spec: RouterModelSpec): string {
	return `${spec.provider}/${spec.id}${spec.thinking ? `:${spec.thinking}` : ""}`;
}

export function buildPanelPrompt(
	prompt: string,
	decision: RouterDecision,
	maxChars = DEFAULT_PANEL_MAX_PROMPT_CHARS,
): string {
	const trimmedPrompt = prompt.length > maxChars ? `${prompt.slice(0, maxChars)}…` : prompt;
	return `You are one advisory panelist for Pi's router extension. Give an independent, practical perspective for the primary Pi agent.\n\nImportant constraints:\n- You are read-only and must not assume access to the current repo, tools, files, session history, or local policies unless included below.\n- Call out uncertainty and assumptions.\n- Focus on risks, tradeoffs, likely approach, and checks the primary agent should perform.\n- Be concise but substantive.\n\nRouter route: ${decision.route}\nRouter reason: ${decision.reason}\n\n<user_prompt>\n${trimmedPrompt}\n</user_prompt>`;
}

function truncateText(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function panelFailureDiagnostic(err: Error | null, stderr: string, stdout: string): string {
	const parts: string[] = [];
	const anyErr = err as (Error & { code?: unknown; signal?: unknown; killed?: unknown }) | null;
	if (err?.message) parts.push(`error: ${err.message}`);
	if (anyErr?.code !== undefined) parts.push(`code: ${String(anyErr.code)}`);
	if (anyErr?.signal !== undefined) parts.push(`signal: ${String(anyErr.signal)}`);
	if (anyErr?.killed !== undefined) parts.push(`killed: ${String(anyErr.killed)}`);
	if (stderr.trim()) parts.push(`stderr: ${truncateText(stderr.trim(), 2000)}`);
	if (stdout.trim()) parts.push(`stdout: ${truncateText(stdout.trim(), 500)}`);
	return parts.join("\n") || "no stdout returned";
}

function claudeModelId(spec: RouterModelSpec): string {
	if (/^opus(?:-4[.-]?8)?$/i.test(spec.id)) return "claude-opus-4-8";
	return spec.id;
}

function panelCommand(spec: RouterModelSpec, prompt: string): { cmd: string; args: string[]; json: boolean } {
	if (spec.provider === "claude-cli") {
		return {
			cmd: process.env.CLAUDE_BIN || "claude",
			args: ["--model", claudeModelId(spec), "--tools", "none", "-p", prompt],
			json: false,
		};
	}
	return {
		cmd: process.env.PI_BIN || "pi",
		args: [
			"--mode",
			"json",
			"-p",
			"--provider",
			spec.provider,
			"--model",
			`${spec.id}${spec.thinking ? `:${spec.thinking}` : ""}`,
			"--no-tools",
			"--no-extensions",
			"--no-session",
			"--no-context-files",
			prompt,
		],
		json: true,
	};
}

function panelJsonResult(stdout: string): { text: string; usage?: DelegateUsage; costKnown: boolean } {
	let text = "";
	let usage: DelegateUsage | undefined;
	let costKnown = false;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") continue;
			const content = event.message.content;
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) {
				text = content
					.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
					.map((part) => String(part.text))
					.join("");
			}
			if (isRecord(event.message.usage)) {
				const raw = event.message.usage;
				const cost = isRecord(raw.cost) ? raw.cost : {};
				costKnown = typeof cost.total === "number";
				usage = {
					input: typeof raw.input === "number" ? raw.input : 0,
					output: typeof raw.output === "number" ? raw.output : 0,
					cacheRead: typeof raw.cacheRead === "number" ? raw.cacheRead : 0,
					cacheWrite: typeof raw.cacheWrite === "number" ? raw.cacheWrite : 0,
					totalTokens: typeof raw.totalTokens === "number" ? raw.totalTokens : 0,
					costTotal: typeof cost.total === "number" ? cost.total : 0,
				};
			}
		} catch {}
	}
	return { text: text.trim(), usage, costKnown };
}

export function isAbortError(error: unknown): boolean {
	return Boolean(
		error instanceof Error &&
			(error.name === "AbortError" || ("code" in error && (error as { code?: unknown }).code === "ABORT_ERR")),
	);
}

function abortedPanelResult(spec: RouterModelSpec, started: number): RouterPanelResult {
	const diagnostic = "cancelled by abort signal";
	return { model: modelSpecKey(spec), ok: false, text: diagnostic, diagnostic, latencyMs: Date.now() - started };
}

export function runPanelist(
	spec: RouterModelSpec,
	prompt: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RouterPanelResult> {
	const started = Date.now();
	if (signal?.aborted) return Promise.resolve(abortedPanelResult(spec, started));
	const { cmd, args, json } = panelCommand(spec, prompt);
	return new Promise((resolve) => {
		try {
			execFile(cmd, args, { timeout: timeoutMs, maxBuffer: PANEL_MAX_BUFFER, signal }, (err, stdout, stderr) => {
				const latencyMs = Date.now() - started;
				if (isAbortError(err)) return resolve(abortedPanelResult(spec, started));
				const parsed = json ? panelJsonResult(stdout) : { text: stdout.trim(), usage: undefined, costKnown: false };
				if (err || !parsed.text) {
					const diagnostic = panelFailureDiagnostic(err, stderr, stdout);
					return resolve({ model: modelSpecKey(spec), ok: false, text: diagnostic, diagnostic, latencyMs });
				}
				resolve({
					model: modelSpecKey(spec),
					ok: true,
					text: parsed.text,
					latencyMs,
					usage: parsed.usage,
					costKnown: parsed.costKnown,
				});
			});
		} catch (error) {
			if (isAbortError(error)) return resolve(abortedPanelResult(spec, started));
			const diagnostic = error instanceof Error ? error.message : String(error);
			resolve({ model: modelSpecKey(spec), ok: false, text: diagnostic, diagnostic, latencyMs: Date.now() - started });
		}
	});
}

export async function runSubprocessPanel(request: RouterPanelRequest): Promise<RouterPanelResult[]> {
	const prompt = buildPanelPrompt(request.prompt, request.decision, request.spec.maxPromptChars);
	const models = request.spec.models.slice(0, request.spec.maxPanelists);
	return Promise.all(models.map((spec) => runPanelist(spec, prompt, request.spec.timeoutMs, request.signal)));
}

export function formatAdvisoryContext(
	results: RouterPanelResult[],
	decision: RouterDecision,
	maxTotalChars = DEFAULT_PANEL_MAX_TOTAL_CHARS,
): string | undefined {
	const successful = results.filter((result) => result.ok && result.text.trim());
	if (!successful.length) return undefined;
	const blocks = successful
		.map(
			(result) =>
				`<router-panel-perspective model="${result.model}" latency_ms="${result.latencyMs}">\n${truncateText(result.text.trim(), 6000)}\n</router-panel-perspective>`,
		)
		.join("\n\n");
	return `Router advisory synthesis context for route "${decision.route}". These are external panel perspectives fetched before this turn. They are NOT ground truth, may lack repo/session/tool context, and must be verified against the actual conversation, files, tools, and user instructions before acting. Use them to find blind spots; ignore them when they conflict with concrete context.\n\n${truncateText(blocks, maxTotalChars)}`;
}
