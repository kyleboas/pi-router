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

The collision report is intentionally non-gating. It identifies prompts where multiple feature families match, making first-match ordering visible before weighted-classifier experiments. It now separates benign overlaps from harmful near-misses and wrong winners, reports runner-up confidence margins/ties, and records known gaps that are not collisions because the missing route feature never matched.
