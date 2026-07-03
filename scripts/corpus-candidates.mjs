#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ROUTES = new Set(["fast", "code", "reason", "write", "research", "general"]);

function argValue(name, fallback) {
	const prefix = `${name}=`;
	const inline = process.argv.find((arg) => arg.startsWith(prefix));
	if (inline) return inline.slice(prefix.length);
	const index = process.argv.indexOf(name);
	if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
	return fallback;
}

function readJsonl(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line, index) => {
			try {
				return [JSON.parse(line)];
			} catch (error) {
				console.warn(`[corpus:candidates] skipped invalid JSONL line ${index + 1}: ${error.message}`);
				return [];
			}
		});
}

function normalizePrompt(prompt) {
	return prompt.trim().replace(/\s+/g, " ");
}

function slug(prompt, fallback) {
	const base = prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 42);
	return base || fallback;
}

const inputPath = argValue("--input", join(homedir(), ".pi", "agent", "extensions", "misroutes.jsonl"));
const outputPath = argValue("--output", join(process.cwd(), "eval", "corpus-candidates.json"));
const records = readJsonl(inputPath);
const seen = new Set();
const candidates = [];

for (const record of records) {
	if (!record || typeof record.prompt !== "string") continue;
	const prompt = normalizePrompt(record.prompt);
	const observed = typeof record.wrongRoute === "string" && ROUTES.has(record.wrongRoute) ? record.wrongRoute : undefined;
	const corrected = typeof record.correctRoute === "string" && ROUTES.has(record.correctRoute) ? record.correctRoute : undefined;
	if (!prompt || !corrected) continue;
	const key = `${prompt.toLowerCase()}\0${observed ?? ""}\0${corrected}`;
	if (seen.has(key)) continue;
	seen.add(key);
	const index = String(candidates.length + 1).padStart(3, "0");
	candidates.push({
		id: `candidate-${index}-${slug(prompt, "prompt")}`,
		prompt,
		mode: "balanced",
		observedRoute: observed,
		correctedRoute: corrected,
		expected: corrected,
		acceptable: observed && observed !== corrected ? [] : undefined,
		tier: "should",
		source: record.source ?? "unknown",
		rule: typeof record.rule === "string" ? record.rule : undefined,
		confidence: typeof record.confidence === "number" ? record.confidence : undefined,
		note: "Draft from misroutes.jsonl; human must approve expected/acceptable/tier before merging into eval/corpus.json.",
	});
}

writeFileSync(outputPath, `${JSON.stringify(candidates, null, 2)}\n`);
console.log(`Wrote ${candidates.length} candidate corpus cases to ${outputPath}`);
