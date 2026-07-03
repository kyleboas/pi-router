import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
	BeforeAgentStartEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export type RouterMode = "fast" | "balanced" | "strong";
export type RouterRoute = "fast" | "code" | "reason" | "write" | "research" | "general";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type RouterSynthesisStrategy = "off" | "advisory-context";

export type RouterGuardrail = "policy" | "verification";
export type RouterConfigDiagnosticSeverity = "error" | "warning" | "info";

export type RouterRuleId =
	| "fast-mode-trivial"
	| "verification-guard"
	| "policy-guard"
	| "code-keywords"
	| "research-keywords"
	| "reason-keywords"
	| "write-keywords"
	| "general-keywords"
	| "balanced-trivial"
	| "route-stickiness"
	| "default-general";

export interface RouterDecision {
	route: RouterRoute;
	thinkingLevel: ThinkingLevel;
	reason: string;
	confidence?: number;
	signals?: string[];
	guardrails?: RouterGuardrail[];
	rule?: RouterRuleId;
}

export interface RouterFeatureMatch {
	rule: RouterRuleId;
	route: RouterRoute;
	signals: string[];
	guardrails?: RouterGuardrail[];
}

interface RouterRouteCandidate extends RouterDecision {
	selected: boolean;
	score?: number;
	margin?: number;
}

export interface RouterConfigDiagnostic {
	severity: RouterConfigDiagnosticSeverity;
	path: string;
	message: string;
}

export interface RouterModelCandidateStatus {
	model: string;
	found: boolean;
	authenticated?: boolean;
	oauth?: boolean;
	selected: boolean;
	reason?: string;
}

export interface RouterTelemetry extends RouterDecision {
	active: boolean;
	anchorModel?: string;
	selectedModel?: string;
	fallbackReason?: string;
	panelActive?: boolean;
	panelModels?: string[];
	panelOkCount?: number;
	panelFailCount?: number;
	panelLatencyMs?: number;
}

interface RouterModelSpec {
	provider: string;
	id: string;
	thinking?: ThinkingLevel;
}

interface RouterPanelConfigFile {
	strategy?: RouterSynthesisStrategy;
	models?: string[];
	timeoutMs?: number;
	maxPromptChars?: number;
	minPromptChars?: number;
	maxTotalChars?: number;
	maxPanelists?: number;
}

interface RouterSynthesisConfigFile {
	enabled?: boolean;
	routes?: Partial<Record<RouterRoute, RouterPanelConfigFile>>;
}

interface RouterCostControlsConfigFile {
	enabled?: boolean;
	preferCache?: boolean;
	maxDefaultThinking?: ThinkingLevel;
	synthesisMinPromptChars?: number;
	persistHistory?: boolean;
	sessionBudgetUsd?: number;
	dailyBudgetUsd?: number;
	warnAtPct?: number;
	disableSynthesisOverBudget?: boolean;
	maxThinkingOverBudget?: ThinkingLevel;
	synthesisMinConfidence?: number;
	synthesisOnCollision?: boolean;
	synthesisRequireDeepCue?: boolean;
	synthesisCooldownTurns?: number;
	synthesisMaxPerSession?: number;
}

interface RouterConfigFile {
	active?: boolean;
	persistState?: boolean;
	mode?: RouterMode;
	requireOAuth?: boolean;
	anchorModel?: string;
	routes?: Partial<Record<RouterRoute, string | string[]>>;
	extraKeywords?: Partial<Record<RouterRoute, string[]>>;
	synthesis?: RouterSynthesisConfigFile;
	costControls?: RouterCostControlsConfigFile;
	toolProfiles?: Partial<Record<RouterRoute, string[]>>;
}

export interface RouterPanelSpec {
	strategy: RouterSynthesisStrategy;
	models: RouterModelSpec[];
	timeoutMs: number;
	maxPromptChars: number;
	minPromptChars: number;
	maxTotalChars: number;
	maxPanelists: number;
}

interface ResolvedRouterSynthesisConfig {
	enabled: boolean;
	routes: Partial<Record<RouterRoute, RouterPanelSpec>>;
}

interface ResolvedRouterCostControls {
	enabled: boolean;
	preferCache: boolean;
	maxDefaultThinking?: ThinkingLevel;
	synthesisMinPromptChars?: number;
	persistHistory: boolean;
	sessionBudgetUsd?: number;
	dailyBudgetUsd?: number;
	warnAtPct: number;
	disableSynthesisOverBudget: boolean;
	maxThinkingOverBudget?: ThinkingLevel;
	synthesisMinConfidence?: number;
	synthesisOnCollision: boolean;
	synthesisRequireDeepCue: boolean;
	synthesisCooldownTurns: number;
	synthesisMaxPerSession?: number;
}

interface ResolvedRouterConfig {
	configPath: string;
	projectConfigPath: string;
	globalConfigPath: string;
	active: boolean;
	persistState: boolean;
	mode: RouterMode;
	requireOAuth: boolean;
	anchorModel?: string;
	routes: Record<RouterRoute, RouterModelSpec[]>;
	extraKeywords: Partial<Record<RouterRoute, string[]>>;
	synthesis: ResolvedRouterSynthesisConfig;
	costControls: ResolvedRouterCostControls;
	toolProfiles: Partial<Record<RouterRoute, string[]>>;
	diagnostics: RouterConfigDiagnostic[];
}

interface RouterState {
	active: boolean;
	mode: RouterMode;
	anchorModel?: string;
	routerSettingModel: boolean;
}

export interface RouterPanelResult {
	model: string;
	ok: boolean;
	text: string;
	latencyMs: number;
	diagnostic?: string;
}

export interface RouterPanelRequest {
	prompt: string;
	decision: RouterDecision;
	spec: RouterPanelSpec;
	signal?: AbortSignal;
}

export type PanelRunner = (request: RouterPanelRequest) => Promise<RouterPanelResult[]>;

interface RouterOptions {
	panelRunner?: PanelRunner;
	usageHistoryPath?: string;
	misrouteHistoryPath?: string;
	now?: () => Date;
}

const ROUTER_COMMAND = "router";
const ROUTER_FLAG = "router";
const ROUTER_CONFIG_BASENAME = "router.json";
const ROUTES: RouterRoute[] = ["fast", "code", "reason", "write", "research", "general"];
const DEFAULT_PANEL_TIMEOUT_MS = 60_000;
const DEFAULT_PANEL_MAX_PROMPT_CHARS = 6000;
const DEFAULT_PANEL_MIN_PROMPT_CHARS = 200;
const DEFAULT_PANEL_MAX_TOTAL_CHARS = 12_000;
const DEFAULT_PANEL_MAX_PANELISTS = 4;
const PANEL_MAX_BUFFER = 1024 * 1024;

const DEFAULT_ROUTE_MODELS: Record<RouterRoute, string[]> = {
	fast: ["openai-codex/gpt-5.5:minimal", "openai-codex/gpt-5.5:low"],
	code: ["openai-codex/gpt-5.5:high", "openai-codex/gpt-5.5:medium"],
	reason: ["openai-codex/gpt-5.5:high", "openai-codex/gpt-5.5:medium"],
	write: ["openai-codex/gpt-5.5:low", "openai-codex/gpt-5.5:medium"],
	research: ["openai-codex/gpt-5.5:high", "openai-codex/gpt-5.5:medium"],
	general: ["openai-codex/gpt-5.5:low", "openai-codex/gpt-5.5:medium"],
};

const DEFAULT_CONFIG: Required<Pick<RouterConfigFile, "active" | "persistState" | "mode" | "requireOAuth">> = {
	active: false,
	persistState: true,
	mode: "balanced",
	requireOAuth: true,
};

const DEFAULT_COST_CONTROLS: ResolvedRouterCostControls = {
	enabled: true,
	preferCache: true,
	persistHistory: true,
	warnAtPct: 0.8,
	disableSynthesisOverBudget: true,
	synthesisOnCollision: true,
	synthesisRequireDeepCue: false,
	synthesisCooldownTurns: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMode(value: unknown): RouterMode | undefined {
	return value === "fast" || value === "balanced" || value === "strong" ? value : undefined;
}

function normalizeStrategy(value: unknown): RouterSynthesisStrategy | undefined {
	return value === "off" || value === "advisory-context" ? value : undefined;
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
		? value
		: undefined;
}

function normalizeBooleanEnv(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	if (/^(1|true|yes|on)$/i.test(value)) return true;
	if (/^(0|false|no|off)$/i.test(value)) return false;
	return undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function optionalPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function normalizedFraction(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.min(1, value > 1 ? value / 100 : value);
}

function addDiagnostic(
	diagnostics: RouterConfigDiagnostic[] | undefined,
	severity: RouterConfigDiagnosticSeverity,
	path: string,
	message: string,
): void {
	diagnostics?.push({ severity, path, message });
}

function isRouterRoute(value: string): value is RouterRoute {
	return (ROUTES as string[]).includes(value);
}

function isRouterRuleId(value: string): value is RouterRuleId {
	return [
		"fast-mode-trivial",
		"verification-guard",
		"policy-guard",
		"code-keywords",
		"research-keywords",
		"reason-keywords",
		"write-keywords",
		"general-keywords",
		"balanced-trivial",
		"route-stickiness",
		"default-general",
	].includes(value);
}

export function parseModelSpec(value: string): RouterModelSpec | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const thinkingMatch = trimmed.match(/^(.*):(off|minimal|low|medium|high|xhigh)$/i);
	const modelKey = thinkingMatch ? thinkingMatch[1] : trimmed;
	const slashIndex = modelKey.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= modelKey.length - 1) return undefined;
	const provider = modelKey.slice(0, slashIndex).trim();
	const id = modelKey.slice(slashIndex + 1).trim();
	if (!provider || !id) return undefined;
	return { provider, id, thinking: thinkingMatch?.[2].toLowerCase() as ThinkingLevel | undefined };
}

function modelSpecKey(spec: RouterModelSpec): string {
	return `${spec.provider}/${spec.id}${spec.thinking ? `:${spec.thinking}` : ""}`;
}

function parseRouteModels(
	value: unknown,
	fallback: string[],
	diagnostics?: RouterConfigDiagnostic[],
	path = "routes",
): RouterModelSpec[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : undefined;
	if (value !== undefined && !raw) {
		addDiagnostic(diagnostics, "warning", path, "Expected a model string or string array; using default models.");
	}
	const source = raw ?? fallback;
	const parsed = source
		.map((entry, index) => {
			if (typeof entry !== "string") {
				addDiagnostic(diagnostics, "warning", `${path}[${index}]`, "Expected a model string; entry ignored.");
				return undefined;
			}
			const spec = parseModelSpec(entry);
			if (!spec)
				addDiagnostic(diagnostics, "warning", `${path}[${index}]`, `Invalid model spec "${entry}"; entry ignored.`);
			return spec;
		})
		.filter(Boolean) as RouterModelSpec[];
	if (raw && !parsed.length) {
		addDiagnostic(diagnostics, "warning", path, "No valid model specs found; using default models.");
		return fallback.map(parseModelSpec).filter(Boolean) as RouterModelSpec[];
	}
	return parsed;
}

function readCostControlsConfig(
	value: unknown,
	diagnostics?: RouterConfigDiagnostic[],
	path = "costControls",
): RouterCostControlsConfigFile | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		addDiagnostic(diagnostics, "warning", path, "Expected an object; cost controls ignored.");
		return undefined;
	}
	const costControls: RouterCostControlsConfigFile = {};
	if (value.enabled !== undefined) {
		if (typeof value.enabled === "boolean") costControls.enabled = value.enabled;
		else addDiagnostic(diagnostics, "warning", `${path}.enabled`, "Expected a boolean; value ignored.");
	}
	if (value.preferCache !== undefined) {
		if (typeof value.preferCache === "boolean") costControls.preferCache = value.preferCache;
		else addDiagnostic(diagnostics, "warning", `${path}.preferCache`, "Expected a boolean; value ignored.");
	}
	if (value.maxDefaultThinking !== undefined) {
		const level = normalizeThinkingLevel(value.maxDefaultThinking);
		if (level) costControls.maxDefaultThinking = level;
		else
			addDiagnostic(diagnostics, "warning", `${path}.maxDefaultThinking`, "Expected a thinking level; value ignored.");
	}
	if (value.synthesisMinPromptChars !== undefined) {
		if (typeof value.synthesisMinPromptChars === "number")
			costControls.synthesisMinPromptChars = value.synthesisMinPromptChars;
		else addDiagnostic(diagnostics, "warning", `${path}.synthesisMinPromptChars`, "Expected a number; value ignored.");
	}
	for (const booleanKey of [
		"persistHistory",
		"disableSynthesisOverBudget",
		"synthesisOnCollision",
		"synthesisRequireDeepCue",
	] as const) {
		if (value[booleanKey] === undefined) continue;
		if (typeof value[booleanKey] === "boolean") costControls[booleanKey] = value[booleanKey];
		else addDiagnostic(diagnostics, "warning", `${path}.${booleanKey}`, "Expected a boolean; value ignored.");
	}
	for (const numberKey of [
		"sessionBudgetUsd",
		"dailyBudgetUsd",
		"warnAtPct",
		"synthesisMinConfidence",
		"synthesisCooldownTurns",
		"synthesisMaxPerSession",
	] as const) {
		if (value[numberKey] === undefined) continue;
		if (typeof value[numberKey] === "number") costControls[numberKey] = value[numberKey];
		else addDiagnostic(diagnostics, "warning", `${path}.${numberKey}`, "Expected a number; value ignored.");
	}
	if (value.maxThinkingOverBudget !== undefined) {
		const level = normalizeThinkingLevel(value.maxThinkingOverBudget);
		if (level) costControls.maxThinkingOverBudget = level;
		else
			addDiagnostic(
				diagnostics,
				"warning",
				`${path}.maxThinkingOverBudget`,
				"Expected a thinking level; value ignored.",
			);
	}
	return costControls;
}

function readExtraKeywordsConfig(
	value: unknown,
	diagnostics?: RouterConfigDiagnostic[],
	path = "extraKeywords",
): Partial<Record<RouterRoute, string[]>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		addDiagnostic(diagnostics, "warning", path, "Expected an object; extra keywords ignored.");
		return undefined;
	}
	const extraKeywords: Partial<Record<RouterRoute, string[]>> = {};
	for (const key of Object.keys(value)) {
		if (!isRouterRoute(key)) {
			addDiagnostic(diagnostics, "warning", `${path}.${key}`, "Unknown route; entry ignored.");
			continue;
		}
		const keywords = value[key];
		if (!Array.isArray(keywords)) {
			addDiagnostic(diagnostics, "warning", `${path}.${key}`, "Expected a string array; entry ignored.");
			continue;
		}
		const seen = new Set<string>();
		extraKeywords[key] = keywords.filter((keyword, index): keyword is string => {
			const ok = typeof keyword === "string" && Boolean(keyword.trim());
			if (!ok) {
				addDiagnostic(diagnostics, "warning", `${path}.${key}[${index}]`, "Expected a keyword string; entry ignored.");
				return false;
			}
			const normalized = keyword.trim().toLowerCase();
			if (seen.has(normalized)) return false;
			seen.add(normalized);
			return true;
		});
	}
	return extraKeywords;
}

function readToolProfilesConfig(
	value: unknown,
	diagnostics?: RouterConfigDiagnostic[],
	path = "toolProfiles",
): Partial<Record<RouterRoute, string[]>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		addDiagnostic(diagnostics, "warning", path, "Expected an object; tool profiles ignored.");
		return undefined;
	}
	const toolProfiles: Partial<Record<RouterRoute, string[]>> = {};
	for (const key of Object.keys(value)) {
		if (!isRouterRoute(key)) {
			addDiagnostic(diagnostics, "warning", `${path}.${key}`, "Unknown route; entry ignored.");
			continue;
		}
		const tools = value[key];
		if (!Array.isArray(tools)) {
			addDiagnostic(diagnostics, "warning", `${path}.${key}`, "Expected a string array; entry ignored.");
			continue;
		}
		toolProfiles[key] = tools.filter((tool, index): tool is string => {
			const ok = typeof tool === "string" && Boolean(tool.trim());
			if (!ok)
				addDiagnostic(diagnostics, "warning", `${path}.${key}[${index}]`, "Expected a tool name; entry ignored.");
			return ok;
		});
	}
	return toolProfiles;
}

function readSynthesisConfig(
	value: unknown,
	diagnostics?: RouterConfigDiagnostic[],
	path = "synthesis",
): RouterSynthesisConfigFile | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		addDiagnostic(diagnostics, "warning", path, "Expected an object; synthesis config ignored.");
		return undefined;
	}
	const synthesis: RouterSynthesisConfigFile = {};
	if (value.enabled !== undefined) {
		if (typeof value.enabled === "boolean") synthesis.enabled = value.enabled;
		else addDiagnostic(diagnostics, "warning", `${path}.enabled`, "Expected a boolean; value ignored.");
	}
	if (value.routes !== undefined && !isRecord(value.routes)) {
		addDiagnostic(diagnostics, "warning", `${path}.routes`, "Expected an object; routes ignored.");
	}
	if (isRecord(value.routes)) {
		synthesis.routes = {};
		for (const key of Object.keys(value.routes)) {
			if (!isRouterRoute(key)) {
				addDiagnostic(diagnostics, "warning", `${path}.routes.${key}`, "Unknown synthesis route; entry ignored.");
			}
		}
		for (const route of ROUTES) {
			const rawRoute = value.routes[route];
			if (rawRoute === undefined) continue;
			if (!isRecord(rawRoute)) {
				addDiagnostic(diagnostics, "warning", `${path}.routes.${route}`, "Expected an object; route ignored.");
				continue;
			}
			const strategy = normalizeStrategy(rawRoute.strategy);
			if (rawRoute.strategy !== undefined && !strategy) {
				addDiagnostic(diagnostics, "warning", `${path}.routes.${route}.strategy`, "Unknown strategy; value ignored.");
			}
			const models = Array.isArray(rawRoute.models)
				? rawRoute.models.filter((entry, index): entry is string => {
						const ok = typeof entry === "string";
						if (!ok)
							addDiagnostic(
								diagnostics,
								"warning",
								`${path}.routes.${route}.models[${index}]`,
								"Expected a model string; entry ignored.",
							);
						return ok;
					})
				: undefined;
			if (rawRoute.models !== undefined && !Array.isArray(rawRoute.models)) {
				addDiagnostic(
					diagnostics,
					"warning",
					`${path}.routes.${route}.models`,
					"Expected a string array; value ignored.",
				);
			}
			const panel: RouterPanelConfigFile = {};
			if (strategy) panel.strategy = strategy;
			if (models) panel.models = models;
			for (const numberKey of [
				"timeoutMs",
				"maxPromptChars",
				"minPromptChars",
				"maxTotalChars",
				"maxPanelists",
			] as const) {
				const numberValue = rawRoute[numberKey];
				if (numberValue === undefined) continue;
				if (typeof numberValue === "number") panel[numberKey] = numberValue;
				else
					addDiagnostic(
						diagnostics,
						"warning",
						`${path}.routes.${route}.${numberKey}`,
						"Expected a number; value ignored.",
					);
			}
			synthesis.routes[route] = panel;
		}
	}
	return synthesis;
}

function readConfigFileWithDiagnostics(filePath: string): {
	config: RouterConfigFile | null;
	diagnostics: RouterConfigDiagnostic[];
} {
	const diagnostics: RouterConfigDiagnostic[] = [];
	if (!existsSync(filePath)) return { config: null, diagnostics };
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		if (!isRecord(parsed)) {
			addDiagnostic(diagnostics, "warning", filePath, "Expected a JSON object; config ignored.");
			return { config: {}, diagnostics };
		}
		const knownKeys = new Set([
			"active",
			"persistState",
			"mode",
			"requireOAuth",
			"anchorModel",
			"routes",
			"extraKeywords",
			"synthesis",
			"costControls",
			"toolProfiles",
		]);
		for (const key of Object.keys(parsed)) {
			if (!knownKeys.has(key)) addDiagnostic(diagnostics, "warning", `${filePath}.${key}`, "Unknown top-level key.");
		}
		const config: RouterConfigFile = {};
		if (parsed.active !== undefined) {
			if (typeof parsed.active === "boolean") config.active = parsed.active;
			else addDiagnostic(diagnostics, "warning", `${filePath}.active`, "Expected a boolean; value ignored.");
		}
		if (parsed.persistState !== undefined) {
			if (typeof parsed.persistState === "boolean") config.persistState = parsed.persistState;
			else addDiagnostic(diagnostics, "warning", `${filePath}.persistState`, "Expected a boolean; value ignored.");
		}
		if (parsed.mode !== undefined) {
			const mode = normalizeMode(parsed.mode);
			if (mode) config.mode = mode;
			else
				addDiagnostic(diagnostics, "warning", `${filePath}.mode`, "Expected fast, balanced, or strong; value ignored.");
		}
		if (parsed.requireOAuth !== undefined) {
			if (typeof parsed.requireOAuth === "boolean") config.requireOAuth = parsed.requireOAuth;
			else addDiagnostic(diagnostics, "warning", `${filePath}.requireOAuth`, "Expected a boolean; value ignored.");
		}
		if (parsed.anchorModel !== undefined) {
			if (typeof parsed.anchorModel === "string") config.anchorModel = parsed.anchorModel;
			else addDiagnostic(diagnostics, "warning", `${filePath}.anchorModel`, "Expected a string; value ignored.");
		}
		if (parsed.routes !== undefined && !isRecord(parsed.routes)) {
			addDiagnostic(diagnostics, "warning", `${filePath}.routes`, "Expected an object; routes ignored.");
		}
		if (isRecord(parsed.routes)) {
			config.routes = {};
			for (const key of Object.keys(parsed.routes)) {
				if (!isRouterRoute(key))
					addDiagnostic(diagnostics, "warning", `${filePath}.routes.${key}`, "Unknown route; entry ignored.");
			}
			for (const route of ROUTES) {
				const routeValue = parsed.routes[route];
				if (routeValue === undefined) continue;
				if (typeof routeValue === "string" || Array.isArray(routeValue))
					config.routes[route] = routeValue as string | string[];
				else
					addDiagnostic(
						diagnostics,
						"warning",
						`${filePath}.routes.${route}`,
						"Expected a model string or string array; value ignored.",
					);
			}
		}
		config.extraKeywords = readExtraKeywordsConfig(parsed.extraKeywords, diagnostics, `${filePath}.extraKeywords`);
		config.synthesis = readSynthesisConfig(parsed.synthesis, diagnostics, `${filePath}.synthesis`);
		config.costControls = readCostControlsConfig(parsed.costControls, diagnostics, `${filePath}.costControls`);
		config.toolProfiles = readToolProfilesConfig(parsed.toolProfiles, diagnostics, `${filePath}.toolProfiles`);
		return { config, diagnostics };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		addDiagnostic(diagnostics, "error", filePath, `Failed to read config: ${message}`);
		console.warn(`[router] Failed to read ${filePath}: ${message}`);
		return { config: null, diagnostics };
	}
}

function writeConfigFile(filePath: string, config: RouterConfigFile): void {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch (error) {
		console.warn(`[router] Failed to write ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function getConfigPaths(
	cwd: string,
	homeDir = homedir(),
): { projectConfigPath: string; globalConfigPath: string } {
	return {
		projectConfigPath: join(cwd, ".pi", "extensions", ROUTER_CONFIG_BASENAME),
		globalConfigPath: join(homeDir, ".pi", "agent", "extensions", ROUTER_CONFIG_BASENAME),
	};
}

export function parseCostControlsConfig(config?: RouterCostControlsConfigFile): ResolvedRouterCostControls {
	return {
		enabled: config?.enabled ?? DEFAULT_COST_CONTROLS.enabled,
		preferCache: config?.preferCache ?? DEFAULT_COST_CONTROLS.preferCache,
		maxDefaultThinking: config?.maxDefaultThinking,
		synthesisMinPromptChars:
			config?.synthesisMinPromptChars && config.synthesisMinPromptChars > 0
				? Math.floor(config.synthesisMinPromptChars)
				: undefined,
		persistHistory: config?.persistHistory ?? DEFAULT_COST_CONTROLS.persistHistory,
		sessionBudgetUsd: optionalPositiveNumber(config?.sessionBudgetUsd),
		dailyBudgetUsd: optionalPositiveNumber(config?.dailyBudgetUsd),
		warnAtPct: normalizedFraction(config?.warnAtPct) ?? DEFAULT_COST_CONTROLS.warnAtPct,
		disableSynthesisOverBudget: config?.disableSynthesisOverBudget ?? DEFAULT_COST_CONTROLS.disableSynthesisOverBudget,
		maxThinkingOverBudget: config?.maxThinkingOverBudget,
		synthesisMinConfidence: normalizedFraction(config?.synthesisMinConfidence),
		synthesisOnCollision: config?.synthesisOnCollision ?? DEFAULT_COST_CONTROLS.synthesisOnCollision,
		synthesisRequireDeepCue: config?.synthesisRequireDeepCue ?? DEFAULT_COST_CONTROLS.synthesisRequireDeepCue,
		synthesisCooldownTurns:
			optionalNonNegativeInteger(config?.synthesisCooldownTurns) ?? DEFAULT_COST_CONTROLS.synthesisCooldownTurns,
		synthesisMaxPerSession: optionalNonNegativeInteger(config?.synthesisMaxPerSession),
	};
}

export function parseSynthesisConfig(
	config?: RouterSynthesisConfigFile,
	diagnostics?: RouterConfigDiagnostic[],
	path = "synthesis",
): ResolvedRouterSynthesisConfig {
	const routes: Partial<Record<RouterRoute, RouterPanelSpec>> = {};
	for (const route of ROUTES) {
		const raw = config?.routes?.[route];
		if (!raw) continue;
		const strategy = raw.strategy ?? "advisory-context";
		const base = {
			timeoutMs: positiveNumber(raw.timeoutMs, DEFAULT_PANEL_TIMEOUT_MS),
			maxPromptChars: positiveNumber(raw.maxPromptChars, DEFAULT_PANEL_MAX_PROMPT_CHARS),
			minPromptChars: positiveNumber(raw.minPromptChars, DEFAULT_PANEL_MIN_PROMPT_CHARS),
			maxTotalChars: positiveNumber(raw.maxTotalChars, DEFAULT_PANEL_MAX_TOTAL_CHARS),
			maxPanelists: positiveNumber(raw.maxPanelists, DEFAULT_PANEL_MAX_PANELISTS),
		};
		if (strategy === "off") {
			routes[route] = {
				strategy,
				models: [],
				...base,
			};
			continue;
		}
		const models = (raw.models ?? [])
			.map((entry, index) => {
				const spec = parseModelSpec(entry);
				if (!spec)
					addDiagnostic(
						diagnostics,
						"warning",
						`${path}.routes.${route}.models[${index}]`,
						`Invalid model spec "${entry}"; entry ignored.`,
					);
				return spec;
			})
			.filter(Boolean) as RouterModelSpec[];
		if (!models.length) {
			addDiagnostic(
				diagnostics,
				"warning",
				`${path}.routes.${route}.models`,
				"Advisory synthesis route has no valid panel models; route disabled.",
			);
			continue;
		}
		routes[route] = {
			strategy,
			models,
			...base,
		};
	}
	return { enabled: config?.enabled ?? false, routes };
}

export function resolveRouterConfig(cwd: string, homeDir = homedir()): ResolvedRouterConfig {
	const { projectConfigPath, globalConfigPath } = getConfigPaths(cwd, homeDir);
	const global = readConfigFileWithDiagnostics(globalConfigPath);
	const project = readConfigFileWithDiagnostics(projectConfigPath);
	const globalConfig = global.config ?? {};
	const projectConfig = project.config ?? {};
	const selectedConfigPath = existsSync(projectConfigPath) ? projectConfigPath : globalConfigPath;
	const diagnostics = [...global.diagnostics, ...project.diagnostics];
	const merged: RouterConfigFile = {
		...globalConfig,
		...projectConfig,
		routes: { ...globalConfig.routes, ...projectConfig.routes },
		synthesis: {
			...globalConfig.synthesis,
			...projectConfig.synthesis,
			routes: { ...globalConfig.synthesis?.routes, ...projectConfig.synthesis?.routes },
		},
		costControls: { ...globalConfig.costControls, ...projectConfig.costControls },
		extraKeywords: { ...globalConfig.extraKeywords, ...projectConfig.extraKeywords },
		toolProfiles: { ...globalConfig.toolProfiles, ...projectConfig.toolProfiles },
	};
	const routes = Object.fromEntries(
		ROUTES.map((route) => [
			route,
			parseRouteModels(merged.routes?.[route], DEFAULT_ROUTE_MODELS[route], diagnostics, `routes.${route}`),
		]),
	) as Record<RouterRoute, RouterModelSpec[]>;
	const costControls = parseCostControlsConfig(merged.costControls);
	const synthesis = parseSynthesisConfig(merged.synthesis, diagnostics);
	if (costControls.enabled && costControls.synthesisMinPromptChars) {
		for (const spec of Object.values(synthesis.routes)) {
			if (spec) spec.minPromptChars = Math.max(spec.minPromptChars, costControls.synthesisMinPromptChars);
		}
	}
	return {
		configPath: selectedConfigPath,
		projectConfigPath,
		globalConfigPath,
		active: merged.active ?? DEFAULT_CONFIG.active,
		persistState: merged.persistState ?? DEFAULT_CONFIG.persistState,
		mode: merged.mode ?? DEFAULT_CONFIG.mode,
		requireOAuth: merged.requireOAuth ?? DEFAULT_CONFIG.requireOAuth,
		anchorModel: merged.anchorModel,
		routes,
		extraKeywords: merged.extraKeywords ?? {},
		synthesis,
		costControls,
		toolProfiles: merged.toolProfiles ?? {},
		diagnostics,
	};
}

const VERIFICATION_RE =
	/\b(fake|fabricated|false premise|does not exist|built-in|publication date|summari[sz]e .*article|unverified)\b/;
const POLICY_RE =
	/\b(workflow rule|what identity|what should it not trust|when should an agent read|correct workflow)\b/;

const FEATURE_TIE_BREAK_ORDER: RouterRoute[] = ["research", "code", "reason", "write", "fast", "general"];

const ROUTE_FEATURES: Record<Exclude<RouterRoute, "general" | "fast">, RegExp[]> = {
	code: [
		/\binspect files?\b/,
		/\bedit code\b/,
		/\brun (?:npm test|make check|tests?)\b/,
		/\b(refactor|debug|fix|test|typescript|python|javascript|repo|code|implement|function|class|api|failing|traceback|stack|git|pr\b|merge|patch|rename)\b/,
	],
	research: [
		/\b(research|sources?|citations?|evidence|benchmark|eval|novelty|detect|ingest)\b/,
		/\b(?:analytics )?report pipeline\b/,
		/\bhealth report\b/,
		/\b(deploy(?:ment)?|infra(?:structure)?|hosting|provider|production|cron|logs?|degraded|oauth|gateway)\b/,
	],
	reason: [
		/\b(prove|derive|reason|tradeoffs?|architecture|plan|compare|optimi[sz]e|constraints?|why|root cause|assumption|migration|risk|rollback)\b/,
	],
	write: [/\b(write|rewrite|draft|edit|prose|copy|blog|article|report|tone|style|grammar|paragraph|concise)\b/],
};

const ROUTE_BASE_SCORE: Record<RouterRoute, number> = {
	fast: 46,
	code: 54,
	reason: 52,
	write: 50,
	research: 56,
	general: 1,
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordPattern(keyword: string): RegExp | undefined {
	const trimmed = keyword.trim();
	if (!trimmed) return undefined;
	const startsWord = /^[a-z0-9_]/i.test(trimmed);
	const endsWord = /[a-z0-9_]$/i.test(trimmed);
	return new RegExp(`${startsWord ? "\\b" : ""}${escapeRegExp(trimmed)}${endsWord ? "\\b" : ""}`, "i");
}

function extraKeywordMatches(
	text: string,
	route: RouterRoute,
	extraKeywords: Partial<Record<RouterRoute, string[]>> = {},
): string[] {
	return (extraKeywords[route] ?? []).filter((keyword) => keywordPattern(keyword)?.test(text));
}

function extraKeywordSignals(matches: string[]): string[] {
	return matches.map((keyword) => `extra:${keyword.trim()}`);
}

function patternHits(text: string, patterns: RegExp[]): number {
	return patterns.filter((pattern) => pattern.test(text)).length;
}

function looksTrivial(prompt: string): boolean {
	return (
		prompt.length < 220 &&
		/^(hi|hello|thanks|ok|okay|yes|no|summari[sz]e|rewrite|format|explain|what is|what are|what does|who is|define|list|convert|translate|show me|give me|quick(?:ly)?\b|small\b)/i.test(
			prompt.trim(),
		)
	);
}

function isShortFollowup(prompt: string): boolean {
	return (
		prompt.trim().length < 100 &&
		/^(yes|yeah|yep|ok|okay|continue|same\b|same but|do that|go on|keep going|try again|make it|and now|now do|faster|slower|more concise|expand)\b/i.test(
			prompt.trim(),
		)
	);
}

function promptTokens(prompt: string): Set<string> {
	return new Set(
		prompt
			.toLowerCase()
			.split(/[^a-z0-9_]+/i)
			.filter((token) => token.length >= 3),
	);
}

function promptSimilarity(a: string, b: string): number {
	const aTokens = promptTokens(a);
	const bTokens = promptTokens(b);
	if (!aTokens.size && !bTokens.size) return 1;
	let intersection = 0;
	for (const token of aTokens) if (bTokens.has(token)) intersection += 1;
	const union = new Set([...aTokens, ...bTokens]).size;
	return union ? intersection / union : 0;
}

function sameTaskPrompt(a: string, b: string): boolean {
	if (a.trim() === b.trim()) return true;
	if (isShortFollowup(b)) return true;
	return promptSimilarity(a, b) >= 0.35;
}

function scoreConfidence(score: number): number {
	return Math.max(0.55, Math.min(0.94, Number((0.52 + score / 230).toFixed(3))));
}

function marginConfidence(score: number, runnerUpScore: number | undefined, guardrails?: RouterGuardrail[]): number {
	if (guardrails?.length) return 0.95;
	if (runnerUpScore === undefined) return Math.max(0.76, scoreConfidence(score));
	const margin = Math.max(0, score - runnerUpScore);
	return Math.max(0.56, Math.min(0.97, Number((0.55 + score / 400 + margin / 100).toFixed(3))));
}

function routeDecision(
	route: RouterRoute,
	thinkingLevel: ThinkingLevel,
	reason: string,
	signals: string[],
	confidence: number,
	guardrails?: RouterGuardrail[],
	rule?: RouterRuleId,
): RouterDecision {
	return { route, thinkingLevel, reason, signals, confidence, guardrails, rule };
}

function routeCandidate(
	route: RouterRoute,
	thinkingLevel: ThinkingLevel,
	reason: string,
	signals: string[],
	confidence: number,
	guardrails?: RouterGuardrail[],
	rule?: RouterRuleId,
	score?: number,
): RouterRouteCandidate {
	return {
		...routeDecision(route, thinkingLevel, reason, signals, confidence, guardrails, rule),
		score,
		selected: false,
	};
}

function featureCandidate(
	route: Exclude<RouterRoute, "general" | "fast">,
	text: string,
	mode: RouterMode,
	extraMatches: string[],
): RouterRouteCandidate | undefined {
	const hits = patternHits(text, ROUTE_FEATURES[route]);
	if (!hits && !extraMatches.length) return undefined;
	let score = ROUTE_BASE_SCORE[route] + hits * 9 + extraMatches.length * 12;
	if (
		route === "research" &&
		/\b(citations?|sources?|evidence|benchmark|production|logs?|deploy|gateway)\b/.test(text)
	) {
		score += 8;
	}
	if (route === "research" && /\b(draft|write|rewrite)\b/.test(text)) score -= 18;
	if (route === "code" && /\b(failing|fix|debug|traceback|stack|test|repo|patch|implementation)\b/.test(text))
		score += 7;
	if (route === "code" && /\b(api handler|handler|reduce duplication|deduplicate)\b/.test(text)) score += 10;
	if (route === "write" && /\b(draft|write|rewrite|blog|article|prose|tone|style|grammar|paragraph)\b/.test(text))
		score += 7;
	if (route === "reason" && /\b(compare|tradeoffs?|constraints?|architecture|root cause|why|risk|plan)\b/.test(text))
		score += 6;
	return routeCandidate(
		route,
		mode === "fast" && route !== "write" ? "medium" : route === "write" ? "medium" : "high",
		route === "research"
			? "research/production evidence task"
			: route === "code"
				? "coding task"
				: route === "reason"
					? "reasoning/planning task"
					: "writing task",
		[
			route === "research"
				? "research-or-production"
				: route === "code"
					? "code-or-repo"
					: route === "reason"
						? "reasoning-or-planning"
						: "writing-or-editing",
			...extraKeywordSignals(extraMatches),
		],
		scoreConfidence(score),
		undefined,
		`${route}-keywords` as RouterRuleId,
		score,
	);
}

function sortAndCalibrateCandidates(candidates: RouterRouteCandidate[]): RouterRouteCandidate[] {
	const sorted = [...candidates].sort((a, b) => {
		const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
		if (scoreDelta !== 0) return scoreDelta;
		return FEATURE_TIE_BREAK_ORDER.indexOf(a.route) - FEATURE_TIE_BREAK_ORDER.indexOf(b.route);
	});
	return sorted.map((candidate, index) => {
		const runnerUp = index === 0 ? sorted.find((other) => other.route !== candidate.route) : undefined;
		const confidence =
			candidate.rule === "default-general" && !runnerUp
				? (candidate.confidence ?? 0.55)
				: index === 0
					? marginConfidence(candidate.score ?? 0, runnerUp?.score, candidate.guardrails)
					: scoreConfidence(candidate.score ?? 0);
		return {
			...candidate,
			confidence,
			margin: runnerUp ? (candidate.score ?? 0) - (runnerUp.score ?? 0) : undefined,
			selected: index === 0,
		};
	});
}

export function explainRouteCandidates(
	prompt: string,
	mode: RouterMode = "balanced",
	extraKeywords: Partial<Record<RouterRoute, string[]>> = {},
): RouterRouteCandidate[] {
	const text = prompt.toLowerCase();
	const candidates: RouterRouteCandidate[] = [];
	if (VERIFICATION_RE.test(text)) {
		candidates.push(
			routeCandidate(
				"general",
				"medium",
				"false-premise/hallucination guard task",
				["verification-risk", "hallucination-guard"],
				0.95,
				["verification"],
				"verification-guard",
				120,
			),
		);
	}
	if (POLICY_RE.test(text)) {
		candidates.push(
			routeCandidate(
				"general",
				"medium",
				"policy/general pi guidance task",
				["local-policy", "workflow-guidance"],
				0.95,
				["policy"],
				"policy-guard",
				118,
			),
		);
	}
	for (const route of ["research", "code", "reason", "write"] as const) {
		const candidate = featureCandidate(route, text, mode, extraKeywordMatches(text, route, extraKeywords));
		if (candidate) candidates.push(candidate);
	}
	const fastExtra = extraKeywordMatches(text, "fast", extraKeywords);
	if (mode === "fast" && looksTrivial(prompt)) {
		candidates.push(
			routeCandidate(
				"fast",
				"minimal",
				"short simple prompt",
				["fast-mode", "trivial-prompt", ...extraKeywordSignals(fastExtra)],
				0.9,
				undefined,
				"fast-mode-trivial",
				82 + fastExtra.length * 12,
			),
		);
	} else if (looksTrivial(prompt) || fastExtra.length) {
		candidates.push(
			routeCandidate(
				"fast",
				"minimal",
				fastExtra.length ? "configured fast keyword" : "short simple prompt",
				[...(looksTrivial(prompt) ? ["trivial-prompt"] : []), ...extraKeywordSignals(fastExtra)],
				0.85,
				undefined,
				"balanced-trivial",
				ROUTE_BASE_SCORE.fast + (looksTrivial(prompt) ? 18 : 0) + fastExtra.length * 12,
			),
		);
	}
	const generalExtra = extraKeywordMatches(text, "general", extraKeywords);
	if (generalExtra.length) {
		candidates.push(
			routeCandidate(
				"general",
				"medium",
				"configured general keyword",
				extraKeywordSignals(generalExtra),
				0.8,
				undefined,
				"general-keywords",
				50 + generalExtra.length * 12,
			),
		);
	}
	if (!candidates.length) {
		candidates.push(
			routeCandidate("general", "medium", "general task", ["default-general"], 0.55, undefined, "default-general", 1),
		);
	}
	return sortAndCalibrateCandidates(candidates);
}

export function findRouteFeatureMatches(
	prompt: string,
	mode: RouterMode = "balanced",
	extraKeywords: Partial<Record<RouterRoute, string[]>> = {},
): RouterFeatureMatch[] {
	return explainRouteCandidates(prompt, mode, extraKeywords)
		.filter((candidate) => candidate.rule !== "default-general")
		.map((candidate) => ({
			guardrails: candidate.guardrails,
			route: candidate.route,
			rule: candidate.rule as RouterRuleId,
			signals: candidate.signals ?? [],
		}));
}

function stickyDecision(
	prompt: string,
	selected: RouterDecision,
	previousDecision?: RouterDecision,
): RouterDecision | undefined {
	if (!previousDecision || !isShortFollowup(prompt)) return undefined;
	if (selected.rule && !["default-general", "balanced-trivial", "fast-mode-trivial"].includes(selected.rule))
		return undefined;
	const faster = /\b(faster|quick|quickly)\b/i.test(prompt);
	const slower = /\b(slower|careful|carefully|deeper|expand)\b/i.test(prompt);
	const thinkingLevel = faster
		? minThinking(previousDecision.thinkingLevel, "low")
		: slower
			? maxThinking(previousDecision.thinkingLevel, "high")
			: previousDecision.thinkingLevel;
	return routeDecision(
		previousDecision.route,
		thinkingLevel,
		"short follow-up inherits previous route",
		["route-stickiness", ...(faster ? ["faster-followup"] : []), ...(slower ? ["deeper-followup"] : [])],
		0.78,
		previousDecision.guardrails,
		"route-stickiness",
	);
}

export function analyzePrompt(
	prompt: string,
	mode: RouterMode = "balanced",
	extraKeywords: Partial<Record<RouterRoute, string[]>> = {},
	previousDecision?: RouterDecision,
): RouterDecision {
	const {
		selected: _selected,
		score: _score,
		margin: _margin,
		...decision
	} = explainRouteCandidates(prompt, mode, extraKeywords)[0];
	return stickyDecision(prompt, decision, previousDecision) ?? decision;
}

export function classifyPrompt(
	prompt: string,
	mode: RouterMode = "balanced",
	extraKeywords: Partial<Record<RouterRoute, string[]>> = {},
	previousDecision?: RouterDecision,
): RouterDecision {
	return analyzePrompt(prompt, mode, extraKeywords, previousDecision);
}

const THINKING_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function thinkingRank(level: ThinkingLevel): number {
	return THINKING_ORDER.indexOf(level);
}

function minThinking(a: ThinkingLevel, b: ThinkingLevel): ThinkingLevel {
	return thinkingRank(a) <= thinkingRank(b) ? a : b;
}

function maxThinking(a: ThinkingLevel, b: ThinkingLevel): ThinkingLevel {
	return thinkingRank(a) >= thinkingRank(b) ? a : b;
}

function looksLowRiskCodePrompt(prompt: string): boolean {
	const text = prompt.toLowerCase();
	return (
		text.length < 240 &&
		/\b(one[- ]line|small|simple|rename|format|typo|lint|comment|docs?|import|quick fix)\b/.test(text) &&
		!/\b(failing tests?|debug|traceback|stack|production|security|migration|architecture|regression|incident|root cause)\b/.test(
			text,
		)
	);
}

export function shouldEscalateThinking(prompt: string, decision: RouterDecision): boolean {
	const text = prompt.toLowerCase();
	return Boolean(
		decision.guardrails?.length ||
			(decision.route === "code" && !looksLowRiskCodePrompt(prompt)) ||
			decision.route === "reason" ||
			decision.route === "research" ||
			/\b(think hard|think deeply|carefully|verify|audit|security|production|incident|root cause|architecture|design tradeoffs?|debug|failing tests?|regression)\b/.test(
				text,
			),
	);
}

export function applyCostControlledThinking(
	prompt: string,
	decision: RouterDecision,
	configuredLevel: ThinkingLevel,
	costControls: ResolvedRouterCostControls = DEFAULT_COST_CONTROLS,
): ThinkingLevel {
	if (!costControls.enabled) return configuredLevel;
	let level = configuredLevel;
	if (costControls.maxDefaultThinking && !shouldEscalateThinking(prompt, decision)) {
		level = minThinking(level, costControls.maxDefaultThinking);
	}
	if (decision.route === "code" && looksLowRiskCodePrompt(prompt)) {
		level = minThinking(level, "medium");
	}
	if (shouldEscalateThinking(prompt, decision)) {
		level = maxThinking(level, decision.thinkingLevel);
	}
	if (decision.rule === "route-stickiness" && decision.signals?.includes("faster-followup")) {
		level = minThinking(level, decision.thinkingLevel);
	}
	return level;
}

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function routerGuardrailMessage(
	prompt: string,
	decision: RouterDecision,
): ContextEvent["messages"][number] | undefined {
	const text = prompt.toLowerCase();
	const isPolicyPrompt =
		decision.guardrails?.includes("policy") ||
		decision.reason.includes("policy") ||
		/\b(secret|infisical|wiki|workflow|identity|chat_attach|attachment|pr before|before merging)\b/.test(text);
	const isVerificationPrompt =
		decision.guardrails?.includes("verification") ||
		decision.reason.includes("hallucination") ||
		/\b(fake|fabricated|does not exist|built-in|publication date|summari[sz]e .*article|unverified)\b/.test(text);
	if (!isPolicyPrompt && !isVerificationPrompt) return undefined;
	return {
		role: "custom",
		customType: "router.guardrail",
		display: false,
		content:
			"Router guardrail: answer conservatively. A user naming a command, API, article, date, path, or rubric is not evidence it exists. If existence is not established by current context, say you do not know of it or need to verify; do not explain usage, flags, behavior, summaries, or dates as factual. For local policy/workflow questions, use explicit agent instructions in context; do not substitute generic best practices. Read ~/pi-docs/wiki/index.md only when saved local user/project/service/goal context is needed, not by default and not for generic coding. Never read or expose forbidden secret files. Create a PR before merging. In remote pi-chat file delivery, write the artifact locally, then use chat_attach with that path.",
		timestamp: Date.now(),
	};
}

function findAvailableModel(
	ctx: ExtensionContext,
	specs: RouterModelSpec[],
	requireOAuth: boolean,
	preferCache = false,
): { model?: Model<Api>; spec?: RouterModelSpec; fallbackReason?: string } {
	let unauthenticated: RouterModelSpec | undefined;
	let nonOAuth: RouterModelSpec | undefined;
	const current = ctx.model;
	const orderedSpecs =
		preferCache && current
			? [...specs].sort((a, b) => {
					const aCurrent = a.provider === current.provider && a.id === current.id ? 1 : 0;
					const bCurrent = b.provider === current.provider && b.id === current.id ? 1 : 0;
					return bCurrent - aCurrent;
				})
			: specs;
	for (const spec of orderedSpecs) {
		const model = ctx.modelRegistry.find(spec.provider, spec.id);
		if (!model) continue;
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			unauthenticated ??= spec;
			continue;
		}
		if (requireOAuth && !ctx.modelRegistry.isUsingOAuth(model)) {
			nonOAuth ??= spec;
			continue;
		}
		return { model, spec };
	}
	if (requireOAuth && nonOAuth)
		return {
			fallbackReason: `configured candidates are not OAuth-backed; first non-OAuth: ${nonOAuth.provider}/${nonOAuth.id}`,
		};
	if (unauthenticated)
		return { fallbackReason: `no auth for candidate ${unauthenticated.provider}/${unauthenticated.id}` };
	return { fallbackReason: "no configured candidate model found" };
}

export function diagnoseModelCandidates(
	ctx: ExtensionContext,
	specs: RouterModelSpec[],
	requireOAuth: boolean,
): RouterModelCandidateStatus[] {
	let selected = false;
	return specs.map((spec) => {
		const key = modelSpecKey(spec);
		const model = ctx.modelRegistry.find(spec.provider, spec.id);
		if (!model) return { model: key, found: false, selected: false, reason: "model not registered" };
		const authenticated = ctx.modelRegistry.hasConfiguredAuth(model);
		if (!authenticated)
			return { model: key, found: true, authenticated, selected: false, reason: "no configured auth" };
		const oauth = ctx.modelRegistry.isUsingOAuth(model);
		if (requireOAuth && !oauth)
			return { model: key, found: true, authenticated, oauth, selected: false, reason: "not OAuth-backed" };
		if (!selected) {
			selected = true;
			return { model: key, found: true, authenticated, oauth, selected: true };
		}
		return { model: key, found: true, authenticated, oauth, selected: false, reason: "available fallback" };
	});
}

interface RouterSynthesisGateState {
	budgetOver?: boolean;
	turnsSinceSynthesis?: number;
	synthesisRuns?: number;
}

function hasSynthesisDeepCue(prompt: string): boolean {
	return /\b(deep review|architecture|tradeoffs?|root cause|migration|design review|risk|risky|compare|prove|investigate|production|incident|audit|security|plan)\b/i.test(
		prompt,
	);
}

export function shouldRunSynthesis(
	decision: RouterDecision,
	config: ResolvedRouterConfig,
	prompt: string,
	gate: RouterSynthesisGateState = {},
): RouterPanelSpec | undefined {
	if (!config.synthesis.enabled) return undefined;
	const spec = config.synthesis.routes[decision.route];
	if (!spec || spec.strategy === "off" || !spec.models.length) return undefined;
	if (prompt.trim().length < spec.minPromptChars) return undefined;
	const controls = config.costControls;
	if (controls.disableSynthesisOverBudget && gate.budgetOver) return undefined;
	if (controls.synthesisMaxPerSession !== undefined && (gate.synthesisRuns ?? 0) >= controls.synthesisMaxPerSession)
		return undefined;
	if ((gate.turnsSinceSynthesis ?? Number.POSITIVE_INFINITY) < controls.synthesisCooldownTurns) return undefined;
	if (controls.synthesisMinConfidence !== undefined && (decision.confidence ?? 0) < controls.synthesisMinConfidence)
		return undefined;
	const routeMatches = findRouteFeatureMatches(prompt, config.mode, config.extraKeywords).map((match) => match.route);
	const collision = new Set(routeMatches).size > 1;
	if (controls.synthesisOnCollision && collision) return spec;
	if (controls.synthesisRequireDeepCue && !hasSynthesisDeepCue(prompt)) return undefined;
	return spec;
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

function panelCommand(spec: RouterModelSpec, prompt: string): { cmd: string; args: string[] } {
	if (spec.provider === "claude-cli") {
		return {
			cmd: process.env.CLAUDE_BIN || "claude",
			args: ["-p", "--model", claudeModelId(spec), "--tools", "none", prompt],
		};
	}
	return {
		cmd: process.env.PI_BIN || "pi",
		args: [
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
	};
}

function isAbortError(error: unknown): boolean {
	return Boolean(
		error instanceof Error &&
			(error.name === "AbortError" || ("code" in error && (error as { code?: unknown }).code === "ABORT_ERR")),
	);
}

function abortedPanelResult(spec: RouterModelSpec, started: number): RouterPanelResult {
	const diagnostic = "cancelled by abort signal";
	return { model: modelSpecKey(spec), ok: false, text: diagnostic, diagnostic, latencyMs: Date.now() - started };
}

function runPanelist(
	spec: RouterModelSpec,
	prompt: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RouterPanelResult> {
	const started = Date.now();
	if (signal?.aborted) return Promise.resolve(abortedPanelResult(spec, started));
	const { cmd, args } = panelCommand(spec, prompt);
	return new Promise((resolve) => {
		try {
			execFile(cmd, args, { timeout: timeoutMs, maxBuffer: PANEL_MAX_BUFFER, signal }, (err, stdout, stderr) => {
				const latencyMs = Date.now() - started;
				if (isAbortError(err)) {
					resolve(abortedPanelResult(spec, started));
					return;
				}
				const text = stdout.trim();
				if (err || !text) {
					const diagnostic = panelFailureDiagnostic(err, stderr, stdout);
					resolve({ model: modelSpecKey(spec), ok: false, text: diagnostic, diagnostic, latencyMs });
					return;
				}
				resolve({ model: modelSpecKey(spec), ok: true, text, latencyMs });
			});
		} catch (error) {
			if (isAbortError(error)) {
				resolve(abortedPanelResult(spec, started));
				return;
			}
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

export function describeDecision(decision: RouterTelemetry): string {
	if (!decision.active) return "Router auto is off.";
	const selected = decision.selectedModel ?? decision.anchorModel ?? "current model";
	const fallback = decision.fallbackReason ? ` Fallback: ${decision.fallbackReason}.` : "";
	const confidence = decision.confidence === undefined ? "" : ` Confidence: ${Math.round(decision.confidence * 100)}%.`;
	const rule = decision.rule ? ` Rule: ${decision.rule}.` : "";
	const signals = decision.signals?.length ? ` Signals: ${decision.signals.join(",")}.` : "";
	const panel = decision.panelActive
		? ` Panel: ${decision.panelOkCount ?? 0}/${(decision.panelOkCount ?? 0) + (decision.panelFailCount ?? 0)} ok.`
		: "";
	return `Router selected ${selected} (${decision.route}, thinking=${decision.thinkingLevel}). Reason: ${decision.reason}.${confidence}${rule}${signals}${fallback}${panel}`;
}

function commandAvailability(command: string): string {
	try {
		const found = execFileSync("which", [command], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return found || "not found on PATH";
	} catch {
		return "not found on PATH";
	}
}

function diagnosticSummary(diagnostics: RouterConfigDiagnostic[]): string {
	if (!diagnostics.length) return "Diagnostics: none";
	return [
		`Diagnostics: ${diagnostics.length}`,
		...diagnostics.map((diagnostic) => `- ${diagnostic.severity} ${diagnostic.path}: ${diagnostic.message}`),
	].join("\n");
}

function candidateStatusSummary(route: RouterRoute, statuses: RouterModelCandidateStatus[]): string {
	if (!statuses.length) return `${route}: no configured candidates`;
	return [
		`${route}: ${statuses.find((status) => status.selected)?.model ?? "no available model"}`,
		...statuses.map((status) => {
			const state = status.selected ? "selected" : (status.reason ?? "available");
			return `  - ${status.model}: ${state}`;
		}),
	].join("\n");
}

interface RouterUsageTotals {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
}

interface RouterCostEvent extends RouterUsageTotals {
	route?: RouterRoute;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	rule?: RouterRuleId;
	confidence?: number;
	signals?: string[];
	sessionId?: string;
	cacheHitRate: number;
}

interface RouterUsageRecord extends Omit<RouterUsageTotals, "turns"> {
	timestamp: string;
	sessionId?: string;
	kind?: "turn" | "panel" | "unrouted";
	active?: boolean;
	route?: RouterRoute;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	rule?: RouterRuleId;
	confidence?: number;
	signals?: string[];
	panelOk?: boolean;
	panelLatencyMs?: number;
}

interface RouterMisrouteRecord {
	timestamp: string;
	sessionId: string;
	source: "explicit" | "implicit-use" | "implicit-effort";
	prompt: string;
	wrongRoute?: RouterRoute;
	correctRoute: RouterRoute;
	wrongThinkingLevel?: ThinkingLevel;
	correctThinkingLevel?: ThinkingLevel;
	rule?: RouterRuleId;
	confidence?: number;
	signals?: string[];
}

interface RouterBudgetStatus {
	sessionCost: number;
	dailyCost: number;
	sessionPct?: number;
	dailyPct?: number;
	overBudget: boolean;
	warn: boolean;
	message?: string;
}

function emptyUsageTotals(): RouterUsageTotals {
	return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };
}

function addUsageTotals(
	total: RouterUsageTotals,
	usage: Partial<Omit<RouterUsageTotals, "turns">>,
	countTurn = true,
): void {
	if (countTurn) total.turns += 1;
	total.input += usage.input ?? 0;
	total.output += usage.output ?? 0;
	total.cacheRead += usage.cacheRead ?? 0;
	total.cacheWrite += usage.cacheWrite ?? 0;
	total.totalTokens += usage.totalTokens ?? 0;
	total.costTotal += usage.costTotal ?? 0;
}

function cacheHitRate(total: Pick<RouterUsageTotals, "input" | "cacheRead" | "cacheWrite">): number {
	const denominator = total.input + total.cacheRead + total.cacheWrite;
	return denominator > 0 ? total.cacheRead / denominator : 0;
}

function dollars(value: number): string {
	return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function formatUsageTotals(label: string, total: RouterUsageTotals): string {
	return `${label}: ${dollars(total.costTotal)}; turns=${total.turns}; tokens=${total.totalTokens}; input=${total.input}; output=${total.output}; cacheRead=${total.cacheRead}; cacheWrite=${total.cacheWrite}; cacheHit=${Math.round(cacheHitRate(total) * 100)}%`;
}

function usageHistoryPath(homeDir = homedir()): string {
	return join(homeDir, ".pi", "agent", "extensions", "router-usage.jsonl");
}

function misrouteHistoryPath(homeDir = homedir()): string {
	return join(homeDir, ".pi", "agent", "extensions", "misroutes.jsonl");
}

function addRecordToTotals(total: RouterUsageTotals, record: RouterUsageRecord): void {
	addUsageTotals(total, record, record.kind !== "panel" && record.kind !== "unrouted");
}

function parseUsageHistoryLine(line: string): RouterUsageRecord | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		if (!isRecord(parsed) || typeof parsed.timestamp !== "string") return undefined;
		return {
			timestamp: parsed.timestamp,
			sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
			kind:
				parsed.kind === "panel"
					? "panel"
					: parsed.kind === "turn"
						? "turn"
						: parsed.kind === "unrouted"
							? "unrouted"
							: undefined,
			active: typeof parsed.active === "boolean" ? parsed.active : undefined,
			route: typeof parsed.route === "string" && isRouterRoute(parsed.route) ? parsed.route : undefined,
			model: typeof parsed.model === "string" ? parsed.model : undefined,
			thinkingLevel: normalizeThinkingLevel(parsed.thinkingLevel),
			rule: typeof parsed.rule === "string" && isRouterRuleId(parsed.rule) ? parsed.rule : undefined,
			confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : undefined,
			signals: Array.isArray(parsed.signals)
				? parsed.signals.filter((signal): signal is string => typeof signal === "string")
				: undefined,
			panelOk: typeof parsed.panelOk === "boolean" ? parsed.panelOk : undefined,
			panelLatencyMs: typeof parsed.panelLatencyMs === "number" ? parsed.panelLatencyMs : undefined,
			input: typeof parsed.input === "number" ? parsed.input : 0,
			output: typeof parsed.output === "number" ? parsed.output : 0,
			cacheRead: typeof parsed.cacheRead === "number" ? parsed.cacheRead : 0,
			cacheWrite: typeof parsed.cacheWrite === "number" ? parsed.cacheWrite : 0,
			totalTokens: typeof parsed.totalTokens === "number" ? parsed.totalTokens : 0,
			costTotal: typeof parsed.costTotal === "number" ? parsed.costTotal : 0,
		};
	} catch {
		return undefined;
	}
}

function readUsageHistory(filePath: string): RouterUsageRecord[] {
	if (!existsSync(filePath)) return [];
	try {
		return readFileSync(filePath, "utf-8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map(parseUsageHistoryLine)
			.filter(Boolean) as RouterUsageRecord[];
	} catch {
		return [];
	}
}

function appendUsageHistory(filePath: string, records: RouterUsageRecord[]): boolean {
	if (!records.length) return true;
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		appendFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
		return true;
	} catch (error) {
		console.warn(
			`[router] Failed to append usage history ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

function appendMisrouteHistory(filePath: string, record: RouterMisrouteRecord): boolean {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
		return true;
	} catch (error) {
		console.warn(
			`[router] Failed to append misroute history ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

function dayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function usageHistorySummary(records: RouterUsageRecord[], now: Date, days = 7): string[] {
	const since = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - Math.max(days - 1, 0));
	const byDay = new Map<string, RouterUsageTotals>();
	for (const record of records) {
		const time = Date.parse(record.timestamp);
		if (!Number.isFinite(time) || time < since) continue;
		const key = record.timestamp.slice(0, 10);
		const total = byDay.get(key) ?? emptyUsageTotals();
		addRecordToTotals(total, record);
		byDay.set(key, total);
	}
	if (!byDay.size) return ["History: none"];
	return [
		`History: last ${days} days`,
		...[...byDay.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([day, total]) => `- ${formatUsageTotals(day, total)}`),
	];
}

function contextUsageSummary(ctx: ExtensionContext): string {
	const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	if (!usage) return "Context: unknown";
	const percent = usage.percent === null ? "unknown" : `${Math.round(usage.percent)}%`;
	const tokens = usage.tokens === null ? "unknown" : String(usage.tokens);
	return `Context: ${tokens}/${usage.contextWindow} (${percent})`;
}

export default function piRouter(pi: ExtensionAPI, options: RouterOptions = {}): void {
	let cachedConfig: ResolvedRouterConfig | undefined;
	const state: RouterState = { active: false, mode: "balanced", routerSettingModel: false };
	const panelRunner = options.panelRunner ?? runSubprocessPanel;
	const now = options.now ?? (() => new Date());
	const historyPath = options.usageHistoryPath ?? usageHistoryPath();
	const misroutePath = options.misrouteHistoryPath ?? misrouteHistoryPath();
	const sessionId = `router-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	let lastDecision: RouterTelemetry | undefined;
	let activeTurnDecision: RouterTelemetry | undefined;
	let lastPrompt: string | undefined;
	const usageTotals = emptyUsageTotals();
	const usageByRoute = new Map<RouterRoute, RouterUsageTotals>();
	const usageByModel = new Map<string, RouterUsageTotals>();
	const pendingUsageRecords: RouterUsageRecord[] = [];
	let latestBudgetAlert: string | undefined;
	let lastBudgetAlertKey: string | undefined;
	let turnCounter = 0;
	let lastSynthesisTurn = Number.NEGATIVE_INFINITY;
	let lastDecisionTurn = Number.NEGATIVE_INFINITY;
	let lastImplicitLabelKey: string | undefined;
	let pendingImplicitLabel:
		| {
				source: "implicit-use" | "implicit-effort";
				correctRoute: RouterRoute;
				correctThinkingLevel?: ThinkingLevel;
				decision: RouterTelemetry;
				prompt: string;
				turn: number;
		  }
		| undefined;
	let synthesisRuns = 0;
	let toolRestore: string[] | undefined;

	function refreshConfig(ctx: ExtensionContext): ResolvedRouterConfig {
		cachedConfig = resolveRouterConfig(ctx.cwd || process.cwd());
		state.active =
			normalizeBooleanEnv(process.env.PI_ROUTER_ACTIVE) ?? (Boolean(pi.getFlag(ROUTER_FLAG)) || cachedConfig.active);
		state.mode = cachedConfig.mode;
		state.anchorModel = cachedConfig.anchorModel ?? state.anchorModel ?? (ctx.model ? modelKey(ctx.model) : undefined);
		return cachedConfig;
	}

	function readWritableConfig(filePath: string): RouterConfigFile & Record<string, unknown> {
		if (!existsSync(filePath)) return {};
		try {
			const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
			return isRecord(parsed) ? (parsed as RouterConfigFile & Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}

	function updateConfigFile(
		config: ResolvedRouterConfig,
		update: (configFile: RouterConfigFile & Record<string, unknown>) => void,
	): void {
		if (!config.persistState) return;
		const configFile = readWritableConfig(config.configPath);
		update(configFile);
		writeConfigFile(config.configPath, configFile);
	}

	function persistState(config: ResolvedRouterConfig): void {
		updateConfigFile(config, (configFile) => {
			configFile.active = state.active;
			configFile.persistState = config.persistState;
			configFile.mode = state.mode;
			configFile.requireOAuth = config.requireOAuth;
			if (state.anchorModel) configFile.anchorModel = state.anchorModel;
		});
	}

	function persistRouteEffort(config: ResolvedRouterConfig, route: RouterRoute, level: ThinkingLevel): void {
		updateConfigFile(config, (configFile) => {
			if (!isRecord(configFile.routes)) configFile.routes = {};
			const routes = configFile.routes as Record<string, string | string[]>;
			const current = routes[route];
			const entries = Array.isArray(current)
				? [...current]
				: typeof current === "string"
					? [current]
					: config.routes[route].map(modelSpecKey);
			const first = parseModelSpec(entries[0] ?? "") ?? config.routes[route][0];
			entries[0] = `${first.provider}/${first.id}:${level}`;
			routes[route] = entries;
		});
	}

	function queueImplicitMisroute(
		source: "implicit-use" | "implicit-effort",
		correctRoute: RouterRoute,
		correctThinkingLevel?: ThinkingLevel,
	): boolean {
		if (!lastDecision?.active || !lastPrompt) return false;
		if (turnCounter - lastDecisionTurn > 3) return false;
		if (
			correctRoute === lastDecision.route &&
			(!correctThinkingLevel || correctThinkingLevel === lastDecision.thinkingLevel)
		)
			return false;
		pendingImplicitLabel = {
			source,
			correctRoute,
			correctThinkingLevel,
			decision: lastDecision,
			prompt: lastPrompt,
			turn: lastDecisionTurn,
		};
		return true;
	}

	function flushImplicitMisroute(nextPrompt: string): void {
		const pending = pendingImplicitLabel;
		if (!pending) return;
		pendingImplicitLabel = undefined;
		if (turnCounter - pending.turn > 3 || !sameTaskPrompt(pending.prompt, nextPrompt)) return;
		const key = `${pending.source}:${pending.turn}:${pending.decision.route}:${pending.correctRoute}:${pending.decision.thinkingLevel}:${pending.correctThinkingLevel ?? ""}`;
		if (key === lastImplicitLabelKey) return;
		lastImplicitLabelKey = key;
		appendMisrouteHistory(misroutePath, {
			timestamp: now().toISOString(),
			sessionId,
			source: pending.source,
			prompt: pending.prompt,
			wrongRoute: pending.decision.route,
			correctRoute: pending.correctRoute,
			wrongThinkingLevel: pending.decision.thinkingLevel,
			correctThinkingLevel: pending.correctThinkingLevel,
			rule: pending.decision.rule,
			confidence: pending.decision.confidence,
			signals: pending.decision.signals,
		});
	}

	function addGuardrailContext(event: ContextEvent): void {
		if (!state.active || !lastDecision?.active) return;
		const latestUser = [...event.messages].reverse().find((message) => message.role === "user");
		const prompt = typeof latestUser?.content === "string" ? latestUser.content : "";
		const guardrail = routerGuardrailMessage(prompt, lastDecision);
		if (guardrail) event.messages.push(guardrail);
		if (latestBudgetAlert) {
			event.messages.push({
				role: "custom",
				customType: "router.budget-alert",
				display: false,
				content: latestBudgetAlert,
				timestamp: Date.now(),
			});
		}
	}

	function applyToolProfile(route: RouterRoute, config: ResolvedRouterConfig): void {
		const profile = config.toolProfiles[route];
		const api = pi as ExtensionAPI & {
			getActiveTools?: () => string[];
			setActiveTools?: (toolNames: string[]) => void;
		};
		if (!profile?.length || typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function")
			return;
		const activeTools = api.getActiveTools();
		if (!toolRestore) toolRestore = activeTools;
		const allowed = new Set(activeTools);
		const nextTools = profile.filter((tool) => allowed.has(tool));
		if (nextTools.length) api.setActiveTools(nextTools);
	}

	function restoreToolProfile(): void {
		const api = pi as ExtensionAPI & { setActiveTools?: (toolNames: string[]) => void };
		if (toolRestore && typeof api.setActiveTools === "function") api.setActiveTools(toolRestore);
		toolRestore = undefined;
	}

	function historyRecordsWithPending(): RouterUsageRecord[] {
		return [...readUsageHistory(historyPath), ...pendingUsageRecords];
	}

	function dailyCost(records = historyRecordsWithPending()): number {
		const today = dayKey(now());
		return records
			.filter((record) => record.timestamp.slice(0, 10) === today)
			.reduce((sum, record) => sum + record.costTotal, 0);
	}

	function budgetStatus(
		config: ResolvedRouterConfig = cachedConfig ?? resolveRouterConfig(process.cwd()),
	): RouterBudgetStatus {
		const controls = config.costControls;
		const sessionCost = usageTotals.costTotal;
		const dayCost = dailyCost();
		const sessionPct = controls.sessionBudgetUsd ? sessionCost / controls.sessionBudgetUsd : undefined;
		const dailyPct = controls.dailyBudgetUsd ? dayCost / controls.dailyBudgetUsd : undefined;
		const overBudget = Boolean(
			(sessionPct !== undefined && sessionPct >= 1) || (dailyPct !== undefined && dailyPct >= 1),
		);
		const warn = Boolean(
			(sessionPct !== undefined && sessionPct >= controls.warnAtPct) ||
				(dailyPct !== undefined && dailyPct >= controls.warnAtPct),
		);
		const parts = [
			controls.sessionBudgetUsd
				? `session ${dollars(sessionCost)}/${dollars(controls.sessionBudgetUsd)}`
				: `session ${dollars(sessionCost)}`,
			controls.dailyBudgetUsd
				? `daily ${dollars(dayCost)}/${dollars(controls.dailyBudgetUsd)}`
				: `daily ${dollars(dayCost)}`,
		];
		return { sessionCost, dailyCost: dayCost, sessionPct, dailyPct, overBudget, warn, message: parts.join("; ") };
	}

	function formatBudgetStatus(config: ResolvedRouterConfig): string {
		const status = budgetStatus(config);
		const stateLabel = status.overBudget ? "over budget" : status.warn ? "warning" : "ok";
		return `Budget: ${stateLabel}; ${status.message}`;
	}

	function emitBudgetAlert(config: ResolvedRouterConfig): void {
		const status = budgetStatus(config);
		if (!status.warn) return;
		const level = status.overBudget ? "over" : "warn";
		const key = `${dayKey(now())}:${level}:${Math.floor(usageTotals.costTotal * 10000)}`;
		if (key === lastBudgetAlertKey) return;
		lastBudgetAlertKey = key;
		latestBudgetAlert = `Router budget ${level}: ${status.message}`;
		pi.events.emit("router:alert", { type: "budget", level, ...status });
	}

	function flushUsageHistory(config: ResolvedRouterConfig = cachedConfig ?? resolveRouterConfig(process.cwd())): void {
		if (!config.costControls.enabled || !config.costControls.persistHistory || !pendingUsageRecords.length) return;
		if (appendUsageHistory(historyPath, pendingUsageRecords)) pendingUsageRecords.splice(0);
	}

	function recordUsage(message: unknown): RouterCostEvent | undefined {
		if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return undefined;
		const usage = message.usage;
		const cost = isRecord(usage.cost) ? usage.cost : {};
		const model =
			typeof message.provider === "string" && typeof message.model === "string"
				? `${message.provider}/${message.model}`
				: activeTurnDecision?.selectedModel;
		const usageDelta = {
			input: typeof usage.input === "number" ? usage.input : 0,
			output: typeof usage.output === "number" ? usage.output : 0,
			cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
			cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
			totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : 0,
			costTotal: typeof cost.total === "number" ? cost.total : 0,
		};
		addUsageTotals(usageTotals, usageDelta);
		if (activeTurnDecision?.route) {
			const routeTotal = usageByRoute.get(activeTurnDecision.route) ?? emptyUsageTotals();
			addUsageTotals(routeTotal, usageDelta);
			usageByRoute.set(activeTurnDecision.route, routeTotal);
		}
		if (model) {
			const modelTotal = usageByModel.get(model) ?? emptyUsageTotals();
			addUsageTotals(modelTotal, usageDelta);
			usageByModel.set(model, modelTotal);
		}
		pendingUsageRecords.push({
			timestamp: now().toISOString(),
			sessionId,
			kind: "turn",
			route: activeTurnDecision?.route,
			model,
			thinkingLevel: activeTurnDecision?.thinkingLevel,
			rule: activeTurnDecision?.rule,
			confidence: activeTurnDecision?.confidence,
			signals: activeTurnDecision?.signals,
			...usageDelta,
		});
		if (cachedConfig) emitBudgetAlert(cachedConfig);
		return {
			...usageTotals,
			route: activeTurnDecision?.route,
			model,
			thinkingLevel: activeTurnDecision?.thinkingLevel,
			rule: activeTurnDecision?.rule,
			confidence: activeTurnDecision?.confidence,
			signals: activeTurnDecision?.signals,
			sessionId,
			cacheHitRate: cacheHitRate(usageTotals),
		};
	}

	function costSummaryLines(ctx?: ExtensionContext): string[] {
		const config = cachedConfig ?? (ctx ? refreshConfig(ctx) : resolveRouterConfig(process.cwd()));
		const lines = ["Router cost", formatUsageTotals("Total", usageTotals), formatBudgetStatus(config)];
		if (latestBudgetAlert) lines.push(latestBudgetAlert);
		if (ctx) lines.push(contextUsageSummary(ctx));
		if (usageByRoute.size) {
			lines.push("By route:");
			for (const [route, total] of usageByRoute) lines.push(`- ${formatUsageTotals(route, total)}`);
		}
		if (usageByModel.size) {
			lines.push("By model:");
			for (const [model, total] of usageByModel) lines.push(`- ${formatUsageTotals(model, total)}`);
		}
		return lines;
	}

	async function routePrompt(
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	): Promise<{ systemPrompt?: string } | undefined> {
		const config = cachedConfig ?? refreshConfig(ctx);
		if (!state.active) {
			lastDecision = {
				active: false,
				route: "general",
				thinkingLevel: pi.getThinkingLevel(),
				reason: "router auto disabled",
				anchorModel: state.anchorModel,
			};
			activeTurnDecision = undefined;
			pi.events.emit("router:decision", lastDecision);
			return;
		}
		turnCounter += 1;
		flushImplicitMisroute(event.prompt);
		lastPrompt = event.prompt;
		const previousDecision = lastDecision?.active ? lastDecision : undefined;
		const decision = classifyPrompt(event.prompt, state.mode, config.extraKeywords, previousDecision);
		const candidates = config.routes[decision.route];
		const { model, spec, fallbackReason } = findAvailableModel(
			ctx,
			candidates,
			config.requireOAuth,
			config.costControls.preferCache,
		);
		let selectedModel = ctx.model ? modelKey(ctx.model) : undefined;
		let thinkingLevel = applyCostControlledThinking(
			event.prompt,
			decision,
			spec?.thinking ?? decision.thinkingLevel,
			config.costControls,
		);
		const currentBudgetStatus = budgetStatus(config);
		if (currentBudgetStatus.overBudget && config.costControls.maxThinkingOverBudget) {
			thinkingLevel = minThinking(thinkingLevel, config.costControls.maxThinkingOverBudget);
		}
		if (model) {
			state.routerSettingModel = true;
			try {
				const ok = await pi.setModel(model);
				if (ok) selectedModel = modelKey(model);
				else selectedModel = ctx.model ? modelKey(ctx.model) : selectedModel;
			} finally {
				state.routerSettingModel = false;
			}
		}
		pi.setThinkingLevel(thinkingLevel);
		lastDecision = {
			...decision,
			thinkingLevel,
			active: true,
			anchorModel: state.anchorModel,
			selectedModel,
			fallbackReason,
		};
		activeTurnDecision = lastDecision;
		lastDecisionTurn = turnCounter;
		applyToolProfile(decision.route, config);

		let systemPrompt = event.systemPrompt;
		const panelSpec = shouldRunSynthesis(decision, config, event.prompt, {
			budgetOver: currentBudgetStatus.overBudget,
			turnsSinceSynthesis: turnCounter - lastSynthesisTurn,
			synthesisRuns,
		});
		if (panelSpec) {
			lastSynthesisTurn = turnCounter;
			synthesisRuns += 1;
			const started = Date.now();
			ctx.ui.setStatus("pi-router", "Routing: consulting advisory panel…");
			let results: RouterPanelResult[];
			try {
				results = await panelRunner({
					prompt: event.prompt,
					decision: { ...decision, thinkingLevel },
					spec: panelSpec,
					signal: ctx.signal,
				});
			} catch (error) {
				const diagnostic = isAbortError(error)
					? "cancelled by abort signal"
					: `panel runner failed: ${error instanceof Error ? error.message : String(error)}`;
				results = panelSpec.models.slice(0, panelSpec.maxPanelists).map((modelSpec) => ({
					model: modelSpecKey(modelSpec),
					ok: false,
					text: diagnostic,
					diagnostic,
					latencyMs: Date.now() - started,
				}));
			} finally {
				ctx.ui.setStatus("pi-router", undefined);
			}
			const panelLatencyMs = Date.now() - started;
			for (const result of results) {
				pendingUsageRecords.push({
					timestamp: now().toISOString(),
					sessionId,
					kind: "panel",
					active: true,
					route: decision.route,
					model: result.model,
					thinkingLevel,
					rule: decision.rule,
					confidence: decision.confidence,
					panelOk: result.ok,
					panelLatencyMs: result.latencyMs,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					costTotal: 0,
				});
			}
			const okCount = results.filter((result) => result.ok).length;
			const failCount = results.length - okCount;
			const panelEvent = {
				route: decision.route,
				strategy: panelSpec.strategy,
				models: results.map((result) => result.model),
				okCount,
				failCount,
				latencyMs: panelLatencyMs,
				results,
			};
			pi.events.emit("router:panel", panelEvent);
			lastDecision = {
				...lastDecision,
				panelActive: true,
				panelModels: results.map((result) => result.model),
				panelOkCount: okCount,
				panelFailCount: failCount,
				panelLatencyMs,
			};
			const advisoryContext = formatAdvisoryContext(results, decision, panelSpec.maxTotalChars);
			if (advisoryContext) systemPrompt = `${systemPrompt}\n\n${advisoryContext}`;
		}

		pi.events.emit("router:decision", lastDecision);
		if (systemPrompt !== event.systemPrompt) return { systemPrompt };
	}

	pi.registerFlag(ROUTER_FLAG, {
		description: "Enable opt-in model routing for this run",
		type: "boolean",
		default: false,
	});

	pi.registerCommand(ROUTER_COMMAND, {
		description:
			"Inspect or control model routing: status | cost [history|daily] | label <route> | doctor | smoke | auto on|off | mode fast|balanced|strong | effort <route|current> <level> | route <text> | use <route>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const config = refreshConfig(ctx);
			const [first, second, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!first || first === "status") {
				const synthesisRoutes = ROUTES.filter((route) => {
					const spec = config.synthesis.routes[route];
					return config.synthesis.enabled && spec && spec.strategy !== "off" && spec.models.length;
				});
				ctx.ui.notify(
					[
						`${state.active ? "Router auto is on" : "Router auto is off"}. Mode: ${state.mode}. Anchor: ${state.anchorModel ?? "none"}. Synthesis: ${synthesisRoutes.length ? synthesisRoutes.join(",") : "off"}.`,
						lastDecision ? describeDecision(lastDecision) : "No decision yet.",
						formatUsageTotals("Cost", usageTotals),
						formatBudgetStatus(config),
						contextUsageSummary(ctx),
					].join("\n"),
					"info",
				);
				return;
			}
			if (first === "auto" && (second === "on" || second === "off")) {
				state.active = second === "on";
				if (!state.anchorModel && ctx.model) state.anchorModel = modelKey(ctx.model);
				persistState(config);
				if (!state.active && state.anchorModel) {
					const anchor = parseModelSpec(state.anchorModel);
					const model = anchor ? ctx.modelRegistry.find(anchor.provider, anchor.id) : undefined;
					if (model) await pi.setModel(model);
				}
				ctx.ui.notify(`Router auto is ${state.active ? "on" : "off"}.`, "info");
				return;
			}
			if (first === "mode" && normalizeMode(second)) {
				state.mode = second as RouterMode;
				persistState(config);
				ctx.ui.notify(`Router mode is ${state.mode}.`, "info");
				return;
			}
			if (first === "cost") {
				if (second === "history") {
					const records = historyRecordsWithPending();
					ctx.ui.notify(
						["Router cost history", `Path: ${historyPath}`, ...usageHistorySummary(records, now())].join("\n"),
						"info",
					);
					return;
				}
				if (second === "daily") {
					const records = historyRecordsWithPending();
					ctx.ui.notify(["Router daily cost", ...usageHistorySummary(records, now(), 14)].join("\n"), "info");
					return;
				}
				ctx.ui.notify(costSummaryLines(ctx).join("\n"), "info");
				return;
			}
			if (first === "label") {
				if (!second || !isRouterRoute(second)) {
					ctx.ui.notify("Usage: /router label <fast|code|reason|write|research|general>", "warning");
					return;
				}
				if (!lastDecision?.active || !lastPrompt) {
					ctx.ui.notify("No active router decision is available to label yet.", "warning");
					return;
				}
				const correctRoute = second;
				const record: RouterMisrouteRecord = {
					timestamp: now().toISOString(),
					sessionId,
					source: "explicit",
					prompt: lastPrompt,
					wrongRoute: lastDecision.route,
					correctRoute,
					wrongThinkingLevel: lastDecision.thinkingLevel,
					rule: lastDecision.rule,
					confidence: lastDecision.confidence,
					signals: lastDecision.signals,
				};
				if (appendMisrouteHistory(misroutePath, record)) {
					ctx.ui.notify(
						`Recorded misroute label: ${lastDecision.route} -> ${correctRoute}. Prompt stored locally at ${misroutePath}.`,
						"info",
					);
				} else {
					ctx.ui.notify(`Failed to record misroute label at ${misroutePath}.`, "warning");
				}
				return;
			}
			if (first === "doctor") {
				const lines = [
					"Router doctor",
					`Config path: ${config.configPath}`,
					`Project config: ${config.projectConfigPath}${existsSync(config.projectConfigPath) ? " (present)" : " (missing)"}`,
					`Global config: ${config.globalConfigPath}${existsSync(config.globalConfigPath) ? " (present)" : " (missing)"}`,
					`PI_ROUTER_ACTIVE: ${process.env.PI_ROUTER_ACTIVE ?? "unset"}`,
					`PI_BIN: ${process.env.PI_BIN ?? "pi"} -> ${commandAvailability(process.env.PI_BIN ?? "pi")}`,
					`CLAUDE_BIN: ${process.env.CLAUDE_BIN ?? "claude"} -> ${commandAvailability(process.env.CLAUDE_BIN ?? "claude")}`,
					`PI_CACHE_RETENTION: ${process.env.PI_CACHE_RETENTION ?? "unset"}`,
					`Cost controls: ${config.costControls.enabled ? "enabled" : "disabled"}; preferCache=${config.costControls.preferCache}; persistHistory=${config.costControls.persistHistory}; maxDefaultThinking=${config.costControls.maxDefaultThinking ?? "none"}; synthesisMinPromptChars=${config.costControls.synthesisMinPromptChars ?? "default"}; synthesisMinConfidence=${config.costControls.synthesisMinConfidence ?? "none"}`,
					`Extra keywords: ${
						Object.entries(config.extraKeywords)
							.flatMap(([route, keywords]) => (keywords ?? []).map((keyword) => `${route}:${keyword}`))
							.join(",") || "none"
					}`,
					`Usage history: ${historyPath}`,
					`Misroute labels: ${misroutePath}`,
					contextUsageSummary(ctx),
					formatUsageTotals("Cost", usageTotals),
					formatBudgetStatus(config),
					diagnosticSummary(config.diagnostics),
					"Routes:",
					...ROUTES.map((route) =>
						candidateStatusSummary(route, diagnoseModelCandidates(ctx, config.routes[route], config.requireOAuth)),
					),
					`Synthesis: ${config.synthesis.enabled ? "enabled" : "disabled"}`,
					...ROUTES.flatMap((route) => {
						const spec = config.synthesis.routes[route];
						return spec
							? [
									`${route} panel: ${spec.strategy}; models=${spec.models.map(modelSpecKey).join(",") || "none"}; minPromptChars=${spec.minPromptChars}; maxTotalChars=${spec.maxTotalChars}; maxPanelists=${spec.maxPanelists}`,
								]
							: [];
					}),
				];
				ctx.ui.notify(
					lines.join("\n"),
					config.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "info",
				);
				return;
			}
			if (first === "smoke") {
				if (!/^(1|true|yes|on)$/i.test(process.env.PI_ROUTER_LIVE ?? "")) {
					ctx.ui.notify("Router smoke is opt-in. Set PI_ROUTER_LIVE=1, then run /router smoke.", "warning");
					return;
				}
				const smokeRoutes = ROUTES.filter((route) => config.synthesis.enabled && config.synthesis.routes[route]);
				const lines = ["Router smoke"];
				for (const route of smokeRoutes) {
					const spec = config.synthesis.routes[route];
					if (!spec) continue;
					const results = await panelRunner({
						prompt: "Router live smoke test. Reply with ok.",
						decision: routeDecision(route, "minimal", "router live smoke", ["smoke"], 1),
						signal: ctx.signal,
						spec: {
							...spec,
							timeoutMs: Math.min(spec.timeoutMs, 15_000),
							maxPanelists: Math.min(spec.maxPanelists, 1),
						},
					});
					const ok = results.filter((result) => result.ok).length;
					lines.push(
						`${route}: ${ok}/${results.length} ok; ${results.map((result) => `${result.model}:${result.latencyMs}ms`).join(",")}`,
					);
				}
				if (!smokeRoutes.length) lines.push("No synthesis routes configured.");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (first === "route") {
				const text = [second, ...rest].filter(Boolean).join(" ");
				const decision = classifyPrompt(text, state.mode, config.extraKeywords);
				const panelSpec = shouldRunSynthesis(decision, config, text, {
					budgetOver: budgetStatus(config).overBudget,
					turnsSinceSynthesis: turnCounter - lastSynthesisTurn,
					synthesisRuns,
				});
				const collisions = [
					...new Set(findRouteFeatureMatches(text, state.mode, config.extraKeywords).map((match) => match.route)),
				];
				ctx.ui.notify(
					`Route: ${decision.route}; thinking=${decision.thinkingLevel}; confidence=${decision.confidence === undefined ? "n/a" : `${Math.round(decision.confidence * 100)}%`}; rule=${decision.rule ?? "unknown"}; signals=${decision.signals?.join(",") || "none"}; collisions=${collisions.join(",") || "none"}; synthesis=${panelSpec ? panelSpec.models.map(modelSpecKey).join(",") : "off"}; reason=${decision.reason}`,
					"info",
				);
				return;
			}
			if (first === "effort") {
				const route = second === "current" ? lastDecision?.route : (second as RouterRoute | undefined);
				const level = rest[0] as ThinkingLevel | undefined;
				const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
				if (!route || !ROUTES.includes(route) || !level || !levels.includes(level)) {
					ctx.ui.notify("Usage: /router effort <route|current> off|minimal|low|medium|high|xhigh", "warning");
					return;
				}
				const specs = config.routes[route];
				if (!specs.length) {
					ctx.ui.notify(`No model configured for ${route}.`, "warning");
					return;
				}
				queueImplicitMisroute("implicit-effort", route, level);
				specs[0].thinking = level;
				persistRouteEffort(config, route, level);
				ctx.ui.notify(`Router ${route} effort is now ${level}.`, "info");
				return;
			}
			if (first === "use" && ROUTES.includes(second as RouterRoute)) {
				const route = second as RouterRoute;
				const found = findAvailableModel(ctx, config.routes[route], config.requireOAuth);
				if (!found.model) {
					ctx.ui.notify(`No model available for ${route}: ${found.fallbackReason ?? "unknown"}`, "warning");
					return;
				}
				queueImplicitMisroute("implicit-use", route, found.spec?.thinking);
				await pi.setModel(found.model);
				if (found.spec?.thinking) pi.setThinkingLevel(found.spec.thinking);
				ctx.ui.notify(`Using ${modelKey(found.model)} for ${route}.`, "info");
				return;
			}
			ctx.ui.notify(
				"Usage: /router status | cost [history|daily] | label <route> | doctor | smoke | auto on|off | mode fast|balanced|strong | effort <route|current> <level> | route <text> | use <route>",
				"warning",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		refreshConfig(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		if (!state.routerSettingModel && ctx.model) state.anchorModel = modelKey(ctx.model);
	});
	pi.on("before_agent_start", routePrompt);
	pi.on("context", addGuardrailContext);
	pi.on("message_end", (event) => {
		const costEvent = isRecord(event) ? recordUsage(event.message) : undefined;
		if (costEvent) pi.events.emit("router:cost", costEvent);
	});
	pi.on("agent_end", () => {
		flushUsageHistory();
		restoreToolProfile();
		activeTurnDecision = undefined;
	});
}

export const _test = {
	ROUTER_FLAG,
	ROUTER_COMMAND,
	ROUTES,
	DEFAULT_ROUTE_MODELS,
	analyzePrompt,
	applyCostControlledThinking,
	buildPanelPrompt,
	cacheHitRate,
	classifyPrompt,
	describeDecision,
	diagnoseModelCandidates,
	explainRouteCandidates,
	findRouteFeatureMatches,
	formatAdvisoryContext,
	getConfigPaths,
	hasSynthesisDeepCue,
	parseCostControlsConfig,
	parseModelSpec,
	promptSimilarity,
	sameTaskPrompt,
	parseSynthesisConfig,
	resolveRouterConfig,
	shouldEscalateThinking,
	shouldRunSynthesis,
	usageHistorySummary,
	usageHistoryPath,
	misrouteHistoryPath,
};
