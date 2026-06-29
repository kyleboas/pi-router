# pi-router

Opt-in model, thinking-level, and advisory synthesis routing for pi.

`router` is designed for subscription/OAuth-backed Pi usage. It chooses a route from the prompt, switches model and thinking level before the provider call, and can optionally ask read-only panel models for advisory context. The final Pi turn still uses one primary model with normal Pi tools/session behavior.

## Install

Install from GitHub:

```bash
pi install git:github.com/kyleboas/pi-router
```

Try without installing:

```bash
pi -e git:github.com/kyleboas/pi-router
```

Manual VPS setup:

```bash
git clone https://github.com/kyleboas/pi-router.git
cd pi-router
npm install
npm run check
pi install .
```

Runtime names stay stable: the command is `/router`, and config lives at `.pi/extensions/router.json` or `~/.pi/agent/extensions/router.json`.

## Enable

Interactive:

```text
/router auto on
/router auto off
```

One run:

```bash
pi --router "fix the failing tests"
```

Headless eval/runtime:

```bash
PI_ROUTER_ACTIVE=1 pi "fix the failing tests"
```

## Commands

- `/router status`
- `/router cost` — show session cost, budgets, token, cache-read/cache-write, route, and model totals
- `/router cost history` — show aggregate JSONL usage history without prompt text
- `/router doctor` — validate config, env overrides, model availability, cache env, cost controls, history path, and synthesis setup
- `/router smoke` — opt-in live panel smoke test; requires `PI_ROUTER_LIVE=1`
- `/router auto on|off`
- `/router mode fast|balanced|strong`
- `/router effort <route|current> off|minimal|low|medium|high|xhigh`
- `/router route <text>` — preview route, thinking level, classifier rule, confidence, signals, and synthesis
- `/router use <fast|code|reason|write|research|general>`

## Config

Project config wins over global config:

- `.pi/extensions/router.json`
- `~/.pi/agent/extensions/router.json`

Routing-only example:

```json
{
  "active": false,
  "persistState": true,
  "mode": "balanced",
  "requireOAuth": true,
  "routes": {
    "fast": ["openai-codex/gpt-5.5:minimal"],
    "code": ["openai-codex/gpt-5.5:medium"],
    "reason": ["openai-codex/gpt-5.5:high"],
    "write": ["openai-codex/gpt-5.5:low", "openai-codex/gpt-5.5:medium"],
    "research": ["openai-codex/gpt-5.5:high", "openai-codex/gpt-5.5:medium"],
    "general": ["openai-codex/gpt-5.5:low", "openai-codex/gpt-5.5:medium"]
  },
  "costControls": {
    "enabled": true,
    "preferCache": true,
    "persistHistory": true,
    "sessionBudgetUsd": 5,
    "dailyBudgetUsd": 20,
    "warnAtPct": 0.8,
    "disableSynthesisOverBudget": true,
    "maxThinkingOverBudget": "medium",
    "synthesisMinPromptChars": 1200,
    "synthesisMinConfidence": 0.75,
    "synthesisOnCollision": true,
    "synthesisCooldownTurns": 1,
    "synthesisMaxPerSession": 3
  }
}
```

Cost controls are conservative and use the same model families. The defaults keep `code`, `reason`, and `research` strong, while `general` and `write` start at lower thinking. Guardrail, code, research, reasoning, production, verification, and explicit “think hard” prompts can still escalate above cheap defaults. Set `PI_CACHE_RETENTION=long` when the backing provider supports prompt caching. Usage history is append-only JSONL at `~/.pi/agent/extensions/router-usage.jsonl` and stores aggregate usage only, never prompt text.

Optional lean tool profiles can reduce context/tool overhead for low-risk routes without enabling tools the user disabled:

```json
{
  "toolProfiles": {
    "fast": ["read", "bash"],
    "write": ["read", "edit", "write"],
    "general": ["read", "bash"]
  }
}
```

Advisory synthesis is off unless explicitly configured. Example enabling it for `reason` and `research`:

```json
{
  "active": true,
  "mode": "strong",
  "requireOAuth": true,
  "synthesis": {
    "enabled": true,
    "routes": {
      "reason": {
        "strategy": "advisory-context",
        "models": [
          "openai-codex/gpt-5.5:xhigh",
          "claude-cli/opus-4.8:medium"
        ],
        "timeoutMs": 60000,
        "minPromptChars": 1200,
        "maxPromptChars": 6000,
        "maxTotalChars": 12000,
        "maxPanelists": 4
      },
      "research": {
        "strategy": "advisory-context",
        "models": [
          "openai-codex/gpt-5.5:xhigh",
          "claude-cli/opus-4.8:medium"
        ],
        "timeoutMs": 60000,
        "minPromptChars": 1200,
        "maxPromptChars": 6000,
        "maxTotalChars": 12000,
        "maxPanelists": 4
      }
    }
  }
}
```

Panel models run without tools/session/context files and their output is injected as advisory system-prompt context. Treat panel output as external perspective, not ground truth. The primary Pi model remains the only tool-using actor. During this preflight step the router shows `Routing: consulting advisory panel…`; Esc/Ctrl-C cancellation is forwarded to panel subprocesses without adding any router-specific timeout cap.

Synthesis controls:

- `timeoutMs`: per-panel subprocess timeout.
- `minPromptChars`: do not run panels for shorter prompts.
- `maxPromptChars`: maximum user prompt characters sent to each panel.
- `maxTotalChars`: aggregate advisory context cap injected into the primary system prompt.
- `maxPanelists`: maximum configured panel models to run.
- `costControls.synthesisMinConfidence`: optional minimum classifier confidence.
- `costControls.synthesisOnCollision`: allow panels for prompts that match multiple route families.
- `costControls.synthesisRequireDeepCue`: require architecture/tradeoff/root-cause/research-style cues.
- `costControls.synthesisCooldownTurns` / `synthesisMaxPerSession`: cap panel frequency.
- `costControls.disableSynthesisOverBudget`: skip panels after session/daily budgets are exceeded.

## Diagnostics and visibility

`/router doctor` reports config paths, `PI_ROUTER_ACTIVE`, `PI_CACHE_RETENTION`, `PI_BIN`/`CLAUDE_BIN` availability, config diagnostics, context usage, usage-history path, cost controls, budgets, per-route model availability, and synthesis configuration. Invalid configured route models now warn and fall back to defaults instead of silently leaving a route empty. State commands preserve unrelated raw route/synthesis config instead of rewriting the whole resolved config.

`/router cost` reports in-memory session totals from assistant usage metadata: dollars, input/output tokens, cache reads/writes, cache hit rate, budget state, and route/model breakdowns. `/router cost history` reports recent aggregate history from JSONL. These counters do not suppress usage; they make expensive paths visible.

`/router smoke` is a live, opt-in panel subprocess check. It refuses to run unless `PI_ROUTER_LIVE=1` is set, uses a tiny prompt, limits each configured route to one panelist, and caps timeout at 15 seconds.

## Eval hooks

The extension exports pure helpers such as `analyzePrompt`, `classifyPrompt`, `parseSynthesisConfig`, and `formatAdvisoryContext`. Test-only diagnostics also expose route candidates for eval reports.

Classifier regression eval:

```bash
npm run test -- __tests__/eval-corpus.test.ts
```

The eval corpus lives in `eval/corpus.json`, with accepted snapshots in `eval/baseline.report.json` and `eval/collision.report.json`. Labels are human judgments; current classifier misses should be marked with `knownGap`, not copied into `expected`.

The baseline report includes rule attribution, known gaps by rule, and confidence calibration buckets. The collision report is non-gating and shows prompts where multiple route feature families match before first-match ordering selects one, including winner confidence, runner-up route, margin/tie buckets, and whether each overlap is benign, a harmful near-miss, or a wrong winner.

It emits structured telemetry on `pi.events`:

```text
router:decision
router:panel
router:cost
router:alert
```

`router:decision` includes route, selected model, thinking level, reason, classifier rule, confidence, matched signals, fallback reason, and panel summary when synthesis ran. `router:panel` includes panel models, success/failure counts, latency, and raw panel results. `router:cost` includes session totals, latest route/model/thinking, token counts, cache reads/writes, total cost, and cache hit rate. `router:alert` emits soft budget threshold crossings.
