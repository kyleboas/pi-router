import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	_test,
	analyzePrompt,
	type RouterGuardrail,
	type RouterMode,
	type RouterRoute,
	type RouterRuleId,
} from "../extensions/index.js";

type EvalTier = "must" | "should";
type ConfidenceBucket = "0.00-0.60" | "0.60-0.80" | "0.80-0.90" | "0.90-1.00";
type CollisionHarm = "benign" | "harmful-near-miss" | "winner-wrong";
type MarginBucket = "negative" | "tie" | "0.01-0.05" | "0.06-0.10" | ">0.10" | "none";

interface EvalCase {
	id: string;
	prompt: string;
	mode: RouterMode;
	expected: RouterRoute;
	acceptable?: RouterRoute[];
	tier: EvalTier;
	expectGuardrails?: RouterGuardrail[];
	expectSignals?: string[];
	knownGap?: boolean;
	note?: string;
}

const ROUTES = _test.ROUTES as RouterRoute[];
const ROUTE_SET = new Set<string>(ROUTES);
const MODES = new Set<string>(["fast", "balanced", "strong"] satisfies RouterMode[]);
const TIERS = new Set<string>(["must", "should"] satisfies EvalTier[]);
const GUARDRAILS = new Set<string>(["policy", "verification"] satisfies RouterGuardrail[]);
const RULES = new Set<string>([
	"fast-mode-trivial",
	"verification-guard",
	"policy-guard",
	"code-keywords",
	"research-keywords",
	"reason-keywords",
	"write-keywords",
	"balanced-trivial",
	"default-general",
] satisfies RouterRuleId[]);
const MAX_KNOWN_GAPS = 2;
const MAX_HARMFUL_COLLISIONS = 16;

function corpusPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "corpus.json");
}

function assertRoute(value: unknown, path: string): asserts value is RouterRoute {
	expect(typeof value, `${path} should be a string`).toBe("string");
	expect(ROUTE_SET.has(value as string), `${path} should be one of ${ROUTES.join(", ")}`).toBe(true);
}

function loadCorpus(): EvalCase[] {
	const raw = JSON.parse(readFileSync(corpusPath(), "utf-8")) as unknown;
	expect(Array.isArray(raw), "corpus root should be an array").toBe(true);
	const cases = raw as Array<Record<string, unknown>>;
	const ids = new Set<string>();
	for (const [index, testCase] of cases.entries()) {
		const path = `case[${index}]`;
		expect(typeof testCase.id, `${path}.id should be a string`).toBe("string");
		expect(ids.has(testCase.id as string), `${path}.id should be unique`).toBe(false);
		ids.add(testCase.id as string);
		expect(typeof testCase.prompt, `${path}.prompt should be a string`).toBe("string");
		expect((testCase.prompt as string).trim().length, `${path}.prompt should be non-empty`).toBeGreaterThan(0);
		expect(MODES.has(testCase.mode as string), `${path}.mode should be fast, balanced, or strong`).toBe(true);
		assertRoute(testCase.expected, `${path}.expected`);
		expect(TIERS.has(testCase.tier as string), `${path}.tier should be must or should`).toBe(true);
		if (testCase.acceptable !== undefined) {
			expect(Array.isArray(testCase.acceptable), `${path}.acceptable should be an array`).toBe(true);
			for (const [acceptableIndex, route] of (testCase.acceptable as unknown[]).entries()) {
				assertRoute(route, `${path}.acceptable[${acceptableIndex}]`);
			}
		}
		if (testCase.expectGuardrails !== undefined) {
			expect(Array.isArray(testCase.expectGuardrails), `${path}.expectGuardrails should be an array`).toBe(true);
			for (const [guardrailIndex, guardrail] of (testCase.expectGuardrails as unknown[]).entries()) {
				expect(typeof guardrail, `${path}.expectGuardrails[${guardrailIndex}] should be a string`).toBe("string");
				expect(
					GUARDRAILS.has(guardrail as string),
					`${path}.expectGuardrails[${guardrailIndex}] should be policy or verification`,
				).toBe(true);
			}
		}
		if (testCase.expectSignals !== undefined) {
			expect(Array.isArray(testCase.expectSignals), `${path}.expectSignals should be an array`).toBe(true);
			for (const [signalIndex, signal] of (testCase.expectSignals as unknown[]).entries()) {
				expect(typeof signal, `${path}.expectSignals[${signalIndex}] should be a string`).toBe("string");
			}
		}
		if (testCase.knownGap !== undefined) {
			expect(typeof testCase.knownGap, `${path}.knownGap should be a boolean`).toBe("boolean");
		}
		if (testCase.note !== undefined) {
			expect(typeof testCase.note, `${path}.note should be a string`).toBe("string");
		}
	}
	return cases as unknown as EvalCase[];
}

function makeConfusionMatrix(): Record<RouterRoute, Record<RouterRoute, number>> {
	return Object.fromEntries(
		ROUTES.map((expectedRoute) => [
			expectedRoute,
			Object.fromEntries(ROUTES.map((actualRoute) => [actualRoute, 0])) as Record<RouterRoute, number>,
		]),
	) as Record<RouterRoute, Record<RouterRoute, number>>;
}

function pct(numerator: number, denominator: number): number {
	return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

function confidenceBucket(confidence: number): ConfidenceBucket {
	if (confidence < 0.6) return "0.00-0.60";
	if (confidence < 0.8) return "0.60-0.80";
	if (confidence < 0.9) return "0.80-0.90";
	return "0.90-1.00";
}

function increment(record: Record<string, number>, key: string): void {
	record[key] = (record[key] ?? 0) + 1;
}

function routePair(matches: Array<{ route: RouterRoute }>): string {
	return [...new Set(matches.map((match) => match.route))].sort().join("+");
}

function roundMargin(value: number | undefined): number | null {
	if (value === undefined) return null;
	return Number(value.toFixed(3));
}

function marginBucket(margin: number | null): MarginBucket {
	if (margin === null) return "none";
	if (margin < 0) return "negative";
	if (margin === 0) return "tie";
	if (margin <= 0.05) return "0.01-0.05";
	if (margin <= 0.1) return "0.06-0.10";
	return ">0.10";
}

function collisionHarm(actual: RouterRoute, routes: RouterRoute[], acceptedRoutes: Set<RouterRoute>): CollisionHarm {
	if (!acceptedRoutes.has(actual)) return "winner-wrong";
	return routes.some((route) => !acceptedRoutes.has(route)) ? "harmful-near-miss" : "benign";
}

describe("router eval corpus", () => {
	it("tracks classifier quality against human-labeled prompts", async () => {
		const corpus = loadCorpus();
		const results = corpus.map((testCase) => {
			const decision = analyzePrompt(testCase.prompt, testCase.mode);
			const acceptedRoutes = new Set([testCase.expected, ...(testCase.acceptable ?? [])]);
			const routeAccepted = acceptedRoutes.has(decision.route);
			const guardrailMisses = (testCase.expectGuardrails ?? []).filter(
				(guardrail) => !decision.guardrails?.includes(guardrail),
			);
			const signalMisses = (testCase.expectSignals ?? []).filter((signal) => !decision.signals?.includes(signal));
			expect(decision.confidence, `${testCase.id} confidence should be a number`).toEqual(expect.any(Number));
			expect(decision.confidence, `${testCase.id} confidence should be >= 0`).toBeGreaterThanOrEqual(0);
			expect(decision.confidence, `${testCase.id} confidence should be <= 1`).toBeLessThanOrEqual(1);
			expect(RULES.has(decision.rule as string), `${testCase.id} should include a known classifier rule`).toBe(true);
			return {
				id: testCase.id,
				tier: testCase.tier,
				mode: testCase.mode,
				expected: testCase.expected,
				acceptable: testCase.acceptable ?? [],
				expectedGuardrails: testCase.expectGuardrails ?? [],
				actual: decision.route,
				thinkingLevel: decision.thinkingLevel,
				confidence: decision.confidence ?? 0,
				rule: decision.rule as RouterRuleId,
				signals: decision.signals ?? [],
				guardrails: decision.guardrails ?? [],
				routeAccepted,
				guardrailMisses,
				signalMisses,
				knownGap: testCase.knownGap === true,
				note: testCase.note,
			};
		});

		const confusion = makeConfusionMatrix();
		const ruleHistogram: Record<string, number> = {};
		const knownGapsByRule: Record<string, number> = {};
		const confidenceCalibration: Record<ConfidenceBucket, { count: number; accepted: number; accuracy: number }> = {
			"0.00-0.60": { count: 0, accepted: 0, accuracy: 1 },
			"0.60-0.80": { count: 0, accepted: 0, accuracy: 1 },
			"0.80-0.90": { count: 0, accepted: 0, accuracy: 1 },
			"0.90-1.00": { count: 0, accepted: 0, accuracy: 1 },
		};
		for (const result of results) {
			confusion[result.expected][result.actual] += 1;
			increment(ruleHistogram, result.rule);
			if (result.knownGap && !result.routeAccepted) increment(knownGapsByRule, result.rule);
			const bucket = confidenceBucket(result.confidence);
			confidenceCalibration[bucket].count += 1;
			if (result.routeAccepted) confidenceCalibration[bucket].accepted += 1;
		}
		for (const bucket of Object.values(confidenceCalibration)) {
			bucket.accuracy = pct(bucket.accepted, bucket.count);
		}

		const must = results.filter((result) => result.tier === "must");
		const mustWithoutKnownGap = must.filter((result) => !result.knownGap);
		const unexpectedMustFailures = mustWithoutKnownGap.filter((result) => !result.routeAccepted);
		const guardrailFailures = results.filter((result) => result.guardrailMisses.length > 0);
		const signalFailures = results.filter((result) => result.signalMisses.length > 0);
		const knownGaps = results.filter((result) => result.knownGap && !result.routeAccepted);
		const labeledGuardrails = results.filter((result) => result.expectedGuardrails.length > 0);

		const report = {
			summary: {
				total: results.length,
				must: must.length,
				mustAccuracy: pct(must.filter((result) => result.routeAccepted).length, must.length),
				mustAccuracyExcludingKnownGaps: pct(
					mustWithoutKnownGap.filter((result) => result.routeAccepted).length,
					mustWithoutKnownGap.length,
				),
				allAccuracy: pct(results.filter((result) => result.routeAccepted).length, results.length),
				knownGapFailures: knownGaps.length,
				guardrailRecall: pct(labeledGuardrails.length - guardrailFailures.length, labeledGuardrails.length),
			},
			confusion,
			ruleHistogram,
			knownGapsByRule,
			confidenceCalibration,
			unexpectedMustFailures,
			guardrailFailures,
			signalFailures,
			knownGaps,
			decisions: results.map((result) => ({
				id: result.id,
				mode: result.mode,
				expected: result.expected,
				acceptable: result.acceptable,
				expectedGuardrails: result.expectedGuardrails,
				actual: result.actual,
				thinkingLevel: result.thinkingLevel,
				confidence: result.confidence,
				rule: result.rule,
				signals: result.signals,
				guardrails: result.guardrails,
				routeAccepted: result.routeAccepted,
				knownGap: result.knownGap,
				note: result.note,
			})),
		};

		expect(unexpectedMustFailures).toEqual([]);
		expect(guardrailFailures).toEqual([]);
		expect(signalFailures).toEqual([]);
		expect(knownGaps.length).toBeLessThanOrEqual(MAX_KNOWN_GAPS);
		await expect(`${JSON.stringify(report, null, 2)}\n`).toMatchFileSnapshot("../eval/baseline.report.json");
	});

	it("snapshots route-family collisions for future classifier work", async () => {
		const corpus = loadCorpus();
		const collisionIds = new Set<string>();
		const collisions = corpus
			.map((testCase) => {
				const decision = analyzePrompt(testCase.prompt, testCase.mode);
				const acceptedRoutes = new Set([testCase.expected, ...(testCase.acceptable ?? [])]);
				const candidates = _test.explainRouteCandidates(testCase.prompt, testCase.mode);
				const routes = [...new Set(candidates.map((candidate) => candidate.route))].sort() as RouterRoute[];
				const runnerUp = candidates.find((candidate) => candidate.route !== decision.route);
				const margin = roundMargin(runnerUp ? (decision.confidence ?? 0) - (runnerUp.confidence ?? 0) : undefined);
				const harm = collisionHarm(decision.route, routes, acceptedRoutes);
				return {
					id: testCase.id,
					mode: testCase.mode,
					expected: testCase.expected,
					acceptable: testCase.acceptable ?? [],
					actual: decision.route,
					selectedRule: decision.rule,
					winnerConfidence: decision.confidence ?? 0,
					routeAccepted: acceptedRoutes.has(decision.route),
					harm,
					pair: routePair(candidates),
					routes,
					runnerUp: runnerUp
						? { rule: runnerUp.rule, route: runnerUp.route, confidence: runnerUp.confidence ?? 0 }
						: undefined,
					margin,
					marginBucket: marginBucket(margin),
					tie: margin === 0,
					matches: candidates
						.filter((candidate) => candidate.rule !== "default-general")
						.map((candidate) => ({
							confidence: candidate.confidence ?? 0,
							reason: candidate.reason,
							route: candidate.route,
							rule: candidate.rule,
							selected: candidate.selected,
						})),
					note: testCase.note,
				};
			})
			.filter((result) => result.routes.length > 1)
			.map((result) => {
				collisionIds.add(result.id);
				return result;
			});
		const knownGapNonCollisionIds = corpus
			.filter((testCase) => testCase.knownGap && !collisionIds.has(testCase.id))
			.map((testCase) => testCase.id);

		const byPair: Record<string, number> = {};
		const selectedRuleHistogram: Record<string, number> = {};
		const byHarm: Record<CollisionHarm, number> = { benign: 0, "harmful-near-miss": 0, "winner-wrong": 0 };
		const harmfulByPair: Record<string, number> = {};
		const harmfulBySelectedRule: Record<string, number> = {};
		const marginBuckets: Record<MarginBucket, number> = {
			negative: 0,
			tie: 0,
			"0.01-0.05": 0,
			"0.06-0.10": 0,
			">0.10": 0,
			none: 0,
		};
		for (const collision of collisions) {
			increment(byPair, collision.pair);
			if (collision.selectedRule) increment(selectedRuleHistogram, collision.selectedRule);
			increment(byHarm, collision.harm);
			increment(marginBuckets, collision.marginBucket);
			if (collision.harm !== "benign") {
				increment(harmfulByPair, collision.pair);
				if (collision.selectedRule) increment(harmfulBySelectedRule, collision.selectedRule);
			}
		}
		const harmfulCollisionCount = collisions.filter((collision) => collision.harm !== "benign").length;
		const winnerWrongCount = collisions.filter((collision) => collision.harm === "winner-wrong").length;
		const tieCollisionCount = collisions.filter((collision) => collision.tie).length;

		const report = {
			summary: {
				total: corpus.length,
				collisionCases: collisions.length,
				collisionRate: pct(collisions.length, corpus.length),
				harmfulCollisionCount,
				harmfulCollisionRate: pct(harmfulCollisionCount, collisions.length),
				winnerWrongCount,
				tieCollisionCount,
				knownGapCollisionIds: collisions
					.filter((collision) => corpus.find((testCase) => testCase.id === collision.id)?.knownGap)
					.map((collision) => collision.id),
				knownGapNonCollisionIds,
			},
			byPair,
			byHarm,
			harmfulByPair,
			harmfulBySelectedRule,
			marginBuckets,
			selectedRuleHistogram,
			collisions,
		};

		expect(collisions.length).toBeGreaterThan(0);
		expect(winnerWrongCount).toBe(0);
		expect(harmfulCollisionCount).toBeLessThanOrEqual(MAX_HARMFUL_COLLISIONS);
		expect(collisions.find((collision) => collision.id === "ambiguous-002")?.harm).toBe("harmful-near-miss");
		await expect(`${JSON.stringify(report, null, 2)}\n`).toMatchFileSnapshot("../eval/collision.report.json");
	});
});
