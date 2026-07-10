import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzePrompt, type RouterMode, type RouterRoute } from "../extensions/index.js";

interface FeedbackCase {
	id: string;
	promptHash: string;
	prompt: string;
	expected: RouterRoute;
	mode: RouterMode;
}

const inputPath = resolve(process.env.PI_ROUTER_FEEDBACK_EVAL ?? "eval/local/feedback.json");
const run = existsSync(inputPath) ? describe : describe.skip;

run("local held-out routing feedback", () => {
	it("evaluates only the deterministic holdout split", () => {
		const data = JSON.parse(readFileSync(inputPath, "utf8")) as { holdout: FeedbackCase[] };
		const rows = data.holdout.map((testCase) => {
			const decision = analyzePrompt(testCase.prompt, testCase.mode);
			const correct = decision.route === testCase.expected;
			return {
				id: testCase.id,
				promptHash: testCase.promptHash,
				expected: testCase.expected,
				actual: decision.route,
				confidence: decision.confidence ?? 0,
				correct,
			};
		});
		const accuracy = rows.length ? rows.filter((row) => row.correct).length / rows.length : 0;
		const brier = rows.length
			? rows.reduce((sum, row) => sum + ((row.correct ? 1 : 0) - row.confidence) ** 2, 0) / rows.length
			: 0;
		const reportPath = resolve("eval/local/feedback.report.json");
		mkdirSync(dirname(reportPath), { recursive: true });
		writeFileSync(reportPath, `${JSON.stringify({ total: rows.length, accuracy, brier, rows }, null, 2)}\n`);
		console.log(`Feedback holdout: n=${rows.length}, accuracy=${accuracy.toFixed(3)}, brier=${brier.toFixed(3)}`);
		expect(rows.length).toBeGreaterThan(0);
	});
});
