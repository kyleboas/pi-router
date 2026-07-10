#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const input = resolve(process.argv[2] ?? `${homedir()}/.pi/agent/extensions/misroutes.jsonl`);
const output = resolve(process.argv[3] ?? "eval/local/feedback.json");
if (!existsSync(input)) {
	console.error(`No router feedback found at ${input}. Use /router feedback after a routed turn.`);
	process.exit(1);
}
const records = readFileSync(input, "utf8")
	.split(/\r?\n/)
	.filter(Boolean)
	.flatMap((line) => {
		try {
			const row = JSON.parse(line);
			return typeof row.prompt === "string" && typeof row.correctRoute === "string" ? [row] : [];
		} catch {
			return [];
		}
	});
const deduped = new Map();
for (const row of records) {
	const promptHash = createHash("sha256").update(row.prompt).digest("hex");
	deduped.set(promptHash, {
		id: `feedback-${promptHash.slice(0, 12)}`,
		promptHash,
		prompt: row.prompt,
		expected: row.correctRoute,
		wrongRoute: row.wrongRoute,
		mode: row.mode ?? "balanced",
		timestamp: row.timestamp,
	});
}
const rows = [...deduped.values()].sort((a, b) => a.promptHash.localeCompare(b.promptHash));
const training = rows.filter((row) => Number.parseInt(row.promptHash.slice(0, 2), 16) >= 51);
const holdout = rows.filter((row) => Number.parseInt(row.promptHash.slice(0, 2), 16) < 51);
if (rows.length && !holdout.length) holdout.push(training.shift());
if (rows.length > 1 && !training.length) training.push(holdout.pop());
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
	output,
	`${JSON.stringify({ generatedAt: new Date().toISOString(), source: input, training, holdout }, null, 2)}\n`,
);
console.log(`Wrote ${output}: ${training.length} training, ${holdout.length} held out.`);
console.log("This file contains local prompts and is gitignored. Do not commit it.");
