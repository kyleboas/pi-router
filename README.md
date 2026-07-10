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

- `/router on` / `/router off` — enable hybrid routing plus orchestration, or disable both; in hybrid mode the route selects the primary model
- `/router status`
- `/router cost` — show session cost, budgets, token, cache-read/cache-write, route, and model totals
- `/router cost history` — show aggregate JSONL usage history without prompt text
- `/router cost daily` — show recent daily JSONL cost rollups
- `/router feedback` — interactive route/effort correction for the last decision; stores that prompt locally in `misroutes.jsonl`
- `/router label <route>` — non-interactive form of route feedback
- `npm run corpus:candidates` — draft eval-corpus candidates from local `misroutes.jsonl` for human review; it never edits `eval/corpus.json`
- `/router doctor` — validate config, env overrides, model availability, cache env, cost controls, history path, and synthesis setup
- `/router smoke` — opt-in live panel smoke test; requires `PI_ROUTER_LIVE=1`
- `/router auto on|off`
- `/router orchestrate on|off|status`
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
  "extraKeywords": {
    "research": ["my research service", "custom_pipeline"]
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

Cost controls are conservative and use the same model families. Routing scores all matching feature families, selects the highest score with a fixed tie-break order, derives confidence from the winner/runner-up score margin, and keeps short follow-up turns on the previous route when appropriate. `fast` favors minimal effort, `balanced` keeps `code`, `reason`, and `research` strong while starting `general` and `write` lower, and `strong` raises the route's thinking floor (`xhigh` for code/reason/research, `high` for write/general, and `low` for trivial work). Short low-risk code prompts can de-escalate to medium outside strong mode; guardrail, production, verification, and explicit “think hard” prompts can still escalate above cheap defaults. Set `PI_CACHE_RETENTION=long` when the backing provider supports prompt caching. Usage history is append-only JSONL at `~/.pi/agent/extensions/router-usage.jsonl` and stores aggregate usage only, never prompt text. Usage records include the route, classifier rule, confidence, model, thinking level, session id, token counts, and cost. Pi-backed panels report token/cost metadata; external CLIs that do not expose usage are shown as unpriced calls, making reported totals explicit lower bounds.

`extraKeywords` adds local, config-owned route cues without forking the classifier. Project config overrides global config per route. Use this for personal service names, hostnames, or tool names that should route like an existing family.

`/router feedback` interactively records the route and optional effort that the previous decision should have used; `/router label <route>` is the scriptable route-only equivalent. Labels are append-only JSONL at `~/.pi/agent/extensions/misroutes.jsonl`. Unlike aggregate usage history, feedback intentionally stores prompt text locally. Explicit labels use `source: "explicit"`; `/router use` and `/router effort` can queue implicit labels, written only after a same-task follow-up prompt passes the similarity guard.

`npm run eval:feedback` hashes and deduplicates local feedback, creates a deterministic 80/20 training/holdout split under gitignored `eval/local/`, and evaluates only the holdout prompts. Raw prompts and the generated report remain local. `npm run corpus:candidates -- --input ~/.pi/agent/extensions/misroutes.jsonl --output eval/corpus-candidates.json` remains available to draft human-reviewed committed corpus additions.

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

## Orchestration

Orchestration is opt-in. With auto routing off it pins each turn to the configured orchestration primary; with auto routing on, hybrid mode uses the selected route's primary model while exposing orchestration tools. The primary chooses the worker tier and can use `delegate` to send self-contained work to `small` for narrow search/verification/simple edits or `mid` for nuanced multi-file work, always with a minimal tool allowlist. Mutating workers run in isolated temporary git worktrees; their actual diff determines `filesTouched`, and a clean patch is applied back only after successful completion. Conflicting or failed patches are preserved for review instead of being applied, and mutating delegation is refused outside a git repository rather than falling back to the primary checkout. Worktree isolation prevents accidental concurrent edits but is not a security sandbox. Active workers and tool progress appear in a live widget above the editor until the primary turn ends. Worker sessions can be steered with `continueId` and are stored under `~/.pi/agent/extensions/router-delegates/`. The `consult` tool asks Fable through the Claude CLI as a read-only advisor, and should be used only when the user explicitly asks.

Pool-enabled configuration (other fields show defaults):

```json
{
  "orchestration": {
    "enabled": false,
    "pool": "scoped",
    "primary": "openai-codex/gpt-5.6-sol",
    "workers": {
      "mid": "openai-codex/gpt-5.6-terra:medium",
      "small": "openai-codex/gpt-5.6-luna:low"
    },
    "consultants": { "fable": "claude-cli/claude-fable-5" },
    "delegateTimeoutMs": 600000,
    "consultTimeoutMs": 120000,
    "maxConcurrent": 2,
    "maxOutputChars": 16000
  }
}
```

`pool` can be `"scoped"` or an ordered array of model specs. Scoped pools read `scopedModels` from `.pi/settings.json`, falling back to `~/.pi/agent/settings.json`; project settings win. Pool order is strongest first: the router derives primary from the first available model, mid from the middle, and small from the last. Explicit `primary` or worker slots override their derived pool slot.

Use `/router orchestrate on|off|status` to persistently control the mode. `PI_ROUTER_ORCHESTRATE=1` or `=0` overrides config for a run. Delegate and consult subprocess usage appears in `/router cost` and persisted usage history with `kind: "delegate"` and `kind: "consult"`.

The orchestration charter keeps diagnosis, risky production actions, and final decisions with the primary. For multi-stage work, it adds a post-diagnosis delegation checkpoint: useful bounded implementation or verification can run in parallel, while trivial work or coordination that would delay the critical path stays primary. The primary selects the task-size hint (`small` or `mid`), an exact approved `provider/model`, and effort (`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`) for consequential delegation. The requested model must be in the configured `pool` (or one of the configured worker slots when no pool exists); the router validates session availability and budget before launching, then records the actual model and effort used.

## Diagnostics and visibility

`/router doctor` reports config paths, `PI_ROUTER_ACTIVE`, `PI_CACHE_RETENTION`, `PI_BIN`/`CLAUDE_BIN` availability, config diagnostics, context usage, usage-history path, cost controls, budgets, per-route model availability, and synthesis configuration. Invalid configured route models now warn and fall back to defaults instead of silently leaving a route empty. State commands preserve unrelated raw route/synthesis config instead of rewriting the whole resolved config.

`/router cost` reports in-memory session totals from assistant usage metadata: dollars, input/output tokens, cache reads/writes, cache hit rate, budget state, and route/model breakdowns. `/router cost history` reports recent aggregate history from JSONL, and `/router cost daily` reports recent daily rollups. After a configured session or daily budget is exhausted, synthesis is skipped, primary thinking can be capped with `maxThinkingOverBudget`, and new delegate/consult calls are blocked. Calls already in flight are allowed to finish.

`/router smoke` is a live, opt-in panel subprocess check. It refuses to run unless `PI_ROUTER_LIVE=1` is set, uses a tiny prompt, limits each configured route to one panelist, and caps timeout at 15 seconds.

## Eval hooks

The extension exports pure helpers such as `analyzePrompt`, `classifyPrompt`, `parseSynthesisConfig`, and `formatAdvisoryContext`. Test-only diagnostics also expose route candidates for eval reports.

Classifier regression eval:

```bash
npm run test -- __tests__/eval-corpus.test.ts
```

The eval corpus lives in `eval/corpus.json`, with accepted snapshots in `eval/baseline.report.json` and `eval/collision.report.json`. Labels are human judgments; current classifier misses should be marked with `knownGap`, not copied into `expected`.

The baseline report includes rule attribution, known gaps by rule, and confidence calibration buckets. The collision report shows prompts where multiple route feature families match before scored selection chooses one, including winner confidence, runner-up route, margin/tie buckets, and whether each overlap is benign, a harmful near-miss, or a wrong winner. CI gates wrong winners and harmful-collision regressions.

It emits structured telemetry on `pi.events`:

```text
router:decision
router:panel
router:cost
router:alert
```

`router:decision` includes route, selected model, thinking level, reason, classifier rule, confidence, matched signals, fallback reason, and panel summary when synthesis ran. `router:panel` includes panel models, success/failure counts, latency, and raw panel results. `router:cost` includes session totals, latest route/model/thinking/rule/confidence/session id, token counts, cache reads/writes, total cost, and cache hit rate. `router:alert` emits soft budget threshold crossings.
