#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROUTES = ["fast", "code", "reason", "write", "research", "general"];
const DEFAULT_CANDIDATES = {
	fast: ["openai-codex/gpt-5.5:minimal", "openai-codex/gpt-5.5:low"],
	code: ["openai-codex/gpt-5.5:high", "openai-codex/gpt-5.5:medium", "openai-codex/gpt-5.5:low"],
	reason: ["openai-codex/gpt-5.5:high", "openai-codex/gpt-5.5:medium"],
	write: ["openai-codex/gpt-5.5:low", "openai-codex/gpt-5.5:medium"],
	research: ["openai-codex/gpt-5.5:high", "openai-codex/gpt-5.5:medium"],
	general: ["openai-codex/gpt-5.5:low", "openai-codex/gpt-5.5:medium"],
};

function argValue(name, fallback) {
	const prefix = `${name}=`;
	const inline = process.argv.find((arg) => arg.startsWith(prefix));
	if (inline) return inline.slice(prefix.length);
	const index = process.argv.indexOf(name);
	if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
	return fallback;
}

function hasFlag(name) {
	return process.argv.includes(name);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function assertRoute(route) {
	if (!ROUTES.includes(route)) throw new Error(`Unknown route ${route}. Expected one of ${ROUTES.join(", ")}`);
}

function taskPath(route) {
	return join(process.cwd(), "eval", "tasks", `${route}.json`);
}

function loadTasks(route) {
	const path = taskPath(route);
	if (!existsSync(path)) throw new Error(`Missing task file ${path}`);
	const tasks = readJson(path);
	if (!Array.isArray(tasks)) throw new Error(`${path} must contain an array`);
	return tasks.map((task, index) => {
		if (!task || typeof task !== "object") throw new Error(`${path}[${index}] must be an object`);
		if (typeof task.id !== "string") throw new Error(`${path}[${index}].id must be a string`);
		if (task.route !== route) throw new Error(`${path}[${index}].route must be ${route}`);
		if (typeof task.prompt !== "string" || !task.prompt.trim()) throw new Error(`${path}[${index}].prompt is required`);
		return task;
	});
}

function modelFamily(model) {
	return model.split("/")[0] ?? model;
}

function buildPlan(route, tasks, candidates) {
	return candidates.flatMap((candidate) =>
		tasks.map((task) => ({
			route,
			taskId: task.id,
			model: candidate,
			isDefault: candidate === candidates[0],
			cacheFamily: modelFamily(candidate),
			command: ["pi", "--model", candidate, "--print", task.prompt],
		})),
	);
}

function emptyMetrics(route, model, isDefault) {
	return {
		route,
		model,
		isDefault,
		tasks: 0,
		winOrTieRateVsDefault: null,
		lossRateOfNonTie: null,
		deterministicPassRate: null,
		medianCost: null,
		medianLatencyMs: null,
		safe: false,
		note: "No live runs in dry-run/plan mode.",
	};
}

const route = argValue("--route", undefined);
if (!route) throw new Error("Usage: npm run eval:models -- --route <route> [--dry-run] [--candidates a,b]");
assertRoute(route);
const dryRun = hasFlag("--dry-run") || !hasFlag("--live");
const candidates = (argValue("--candidates", undefined)?.split(",") ?? DEFAULT_CANDIDATES[route]).filter(Boolean);
if (!candidates.length) throw new Error("At least one candidate model is required");
const tasks = loadTasks(route);
const plan = buildPlan(route, tasks, candidates);

const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	route,
	mode: dryRun ? "dry-run" : "live-not-implemented",
	taskCount: tasks.length,
	candidates,
	isolation: {
		piRouterActive: "0",
		noGateways: true,
		noTelegram: true,
		noProdServices: true,
	},
	plan,
	matrix: candidates.map((candidate, index) => emptyMetrics(route, candidate, index === 0)),
	blockers: dryRun
		? []
		: ["Live model execution is intentionally not implemented in this safe scaffold; add explicit sandbox runner before spending tokens."],
};

mkdirSync(join(process.cwd(), "eval"), { recursive: true });
const output = argValue("--output", join(process.cwd(), "eval", "model-matrix.report.json"));
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${dryRun ? "dry-run " : ""}model matrix report to ${output}`);
if (!dryRun) process.exitCode = 2;
