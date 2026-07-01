# Changelog

## 0.3.0

- Add `extraKeywords` config for local route signals without forking classifier code.
- Replace first-match routing with scored route-family selection, margin-based confidence, documented tie-breaks, and route stickiness for short follow-ups.
- Add low-risk code de-escalation and wider fast/trivial prompt detection.
- Enrich aggregate usage history with classifier rule, confidence, and session id.
- Add opt-in `/router label <route>` misroute capture to local `misroutes.jsonl`.
- Add `/router cost daily` rollups.
- Gate harmful collision regressions in eval tests.
- Correct standalone package attribution.

## 0.2.0

- Add conservative cost controls while keeping existing preferred models.
- Add `/router cost`, `/router cost history`, and `router:cost` telemetry.
- Persist aggregate usage history to JSONL without storing prompt text.
- Add soft budget alerts via `router:alert` and budget-aware summaries.
- Add cache-aware model stickiness and cheaper `general`/`write` defaults.
- Add safer advisory synthesis gating and opt-in `/router smoke`.
- Add cautious optional tool profiles for low-risk routes.
- Expand classifier eval corpus coverage for boundary and guardrail prompts.
