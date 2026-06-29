# Contributing

Thanks for improving `pi-router`.

## Development

```bash
npm ci
npm run check
```

`npm run check` runs linting, typechecking, and the Vitest suite.

## Eval corpus

Routing behavior is covered by `eval/corpus.json` and `__tests__/eval-corpus.test.ts`.

- Treat `expected` as a human judgment, not a snapshot of current classifier behavior.
- Use `acceptable` for genuinely ambiguous prompts.
- Use `knownGap: true` only when preserving a known classifier miss is intentional.
- Add a corpus case whenever a real prompt routes surprisingly.
- Update reports with:

```bash
npm run test -- __tests__/eval-corpus.test.ts -u
```

Review report diffs before committing snapshot updates.

## Live checks

`/router smoke` and advisory synthesis can call external model CLIs. Keep live checks opt-in and do not require provider credentials in CI.
