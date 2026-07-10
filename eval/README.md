# pi-router eval corpus

This directory contains the first routing regression eval for `pi-router`.

Run the corpus eval:

```bash
npm run test -- __tests__/eval-corpus.test.ts
```

Update the accepted report snapshot after reviewing intentional classifier changes:

```bash
npm run test -- __tests__/eval-corpus.test.ts -u
```

## Files

- `corpus.json` — human-labeled prompts with expected routes, guardrails, and signals.
- `baseline.report.json` — Vitest file snapshot containing aggregate metrics, rule attribution, confidence buckets, and per-case decisions.
- `collision.report.json` — Vitest file snapshot showing prompts that match multiple route feature families before first-match ordering chooses a route, plus non-gating harm/margin diagnostics.

## Labeling rules

- Treat `expected` as human judgment, not the current classifier output.
- Use `acceptable` for genuinely ambiguous prompts.
- Use `knownGap: true` only when the current classifier is intentionally allowed to miss a case while preserving the gap for future weighted-classifier work.
- Add a corpus case whenever a real prompt routes surprisingly.
- Add boundary cases for route-family collisions such as code+research, reason+write, trivial+code, and guardrail+route overlaps.
- Guardrail labels (`policy`, `verification`) are hard invariants and should not regress.

## Reports

The baseline report includes:

- `ruleHistogram` — which classifier branch selected each route.
- `knownGapsByRule` — accepted misses grouped by the responsible branch.
- `confidenceCalibration` — route acceptance grouped by hardcoded confidence ranges.

The collision report is intentionally non-gating. It identifies prompts where multiple feature families match, separates benign overlaps from harmful near-misses and wrong winners, and reports winner/runner-up routing scores plus the actual score margin used for selection. The baseline also reports Brier score and expected calibration error; curated-corpus calibration is diagnostic and should be compared with held-out real feedback before tuning confidence.

## Local held-out feedback

After recording corrections with `/router feedback`, run:

```bash
npm run eval:feedback
```

This reads `~/.pi/agent/extensions/misroutes.jsonl`, hashes and deduplicates prompts, and creates a deterministic 80/20 training/holdout split. Only holdout cases are evaluated. Generated cases and reports live under gitignored `eval/local/` because they contain prompt text; never commit that directory. Override paths with positional arguments to `scripts/build-feedback-eval.mjs`, or set `PI_ROUTER_FEEDBACK_EVAL` when running the feedback Vitest file directly.
