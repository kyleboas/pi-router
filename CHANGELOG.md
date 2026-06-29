# Changelog

## 0.2.0

- Add conservative cost controls while keeping existing preferred models.
- Add `/router cost`, `/router cost history`, and `router:cost` telemetry.
- Persist aggregate usage history to JSONL without storing prompt text.
- Add soft budget alerts via `router:alert` and budget-aware summaries.
- Add cache-aware model stickiness and cheaper `general`/`write` defaults.
- Add safer advisory synthesis gating and opt-in `/router smoke`.
- Add cautious optional tool profiles for low-risk routes.
- Expand classifier eval corpus coverage for boundary and guardrail prompts.
