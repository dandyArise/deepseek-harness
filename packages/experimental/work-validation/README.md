---
description: "Opt-in execution evidence and bounded verification corrections for development agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-work-validation

English | [中文](README.zh.md)

## Summary

Opt-in experimental development verification. This plugin uses the existing tool pipeline, filesystem provider, durable Session log and stopping hook; it neither executes commands on its own nor grants permissions. It reuses `dsh-tools` schema validation in a monotonic guard, including raw integration tools that do not use `defineTool`. Invalid arguments return path-qualified `INVALID_ARGS` feedback. The registry still owns unknown names and scoped visibility.

## Table of Contents

- [Configuration](#configuration)
- [Evidence and final answers](#evidence-and-final-answers)
- [Reproduce checks](#reproduce-checks)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration

Mount `@deepseek-ai/dsh-work-validation` with `enabled: true` in a trusted profile. Omission or `enabled: false` preserves the existing loop. `maxCorrections` defaults to 2; `maxValidationSteps` bounds extra steps after the first report to 4. Fingerprints default to 10,000 files and 64 MiB per scan; exceeding either produces an explicit unknown observation, never success.

For a local checkout, an overlay can load the source directly (adjust the absolute path):

```yaml
- insert:
    - id: work-validation
      name: 'D:/Github/Projets/IA/deepseek-harness/packages/experimental/work-validation/src/index.ts'
      config:
        enabled: true
        maxCorrections: 2
        maxValidationSteps: 4
```

The production-Loader composition in `tests/fixtures/composition.patch.yml` exercises this overlay mechanism. It does not modify the saved provider/model selection.

Place `.harness-validation.json` at the session working directory:

```json
{
  "mode": "development",
  "checks": [
    { "id": "test", "command": "pnpm run test", "required": true },
    { "id": "typecheck", "command": "pnpm run typecheck", "required": true },
    { "id": "lint", "command": null, "required": true },
    { "id": "build", "command": "pnpm run build", "required": true }
  ]
}
```

Each check optionally names `cwd` relative to the project (default `.`). Commands match exactly, not by substring: `npm test; echo success` does not establish `npm test`. A missing command is `not-run`. Without this file, existing package scripts named `test`, `typecheck`, `lint` and `build` supply commands; lockfiles select pnpm, Bun, Yarn or npm. No command is inferred for another ecosystem: configure it explicitly. `inspection` disables stopping enforcement; `auto` applies it after observable file changes or an explicit verification-success claim. Configuration is trusted project policy, not a tamper-proof adversarial control.

## Evidence and final answers

When an optional `repeat-tool-reminder` notice enters a step, the plugin supplies fresh check statuses and configured commands before the next generation. This does not execute a check, veto a tool, or override an inspection-only task. It closes the feedback gap for agents that repeat tools without reaching their final answer; model compliance still requires real evaluation.

Foreground Bash and PowerShell results record exact command, resolved directory, elapsed dispatch duration, exit code, interruption flags, captured streams and spill references. Background/promoted jobs are not treated as completed checks. Original tool results remain in the Session. Execution records are finalized against the authoritative tool outcome after policy processing. The projection retains only the most recent execution for each configured check; full history remains in ignorable `plugin:work-validation/*` records. Readers without this plugin retain and skip these records. Lost or incompatible evidence becomes unverified, never implicitly passed.

SHA-256 fingerprints cover paths and bytes before and after each shell call and again before the final report, including edits made by shell and external editors. New and deleted files affect the digest. Changing files during execution invalidates that run. Generated directories are excluded by basename (`.git`, `node_modules`, `.venv`, `__pycache__`, `.pytest_cache`, `dist`, `coverage`, `target`); project `exclude` replaces this list. Do not exclude source or tests whose changes should invalidate evidence. Files outside the project and incomplete scans never produce green evidence.

Reports distinguish `passed`, `failed`, `not-run` and `stale`. An exit code of zero proves only its matching check on an unchanged fingerprint, not overall task completion or test quality. Reports are recorded and injected through existing sourced context messages. Every stopping checkpoint supplies current results; a new generation is requested only for detected unsupported success claims, within the configured bound. Honest incomplete work and supported success may finish immediately without a mandatory rewrite. Exhaustion records a visible context report instead of requesting another correction. Normal session cancellation and approval rules still apply.

## Reproduce checks

```powershell
node_modules/.bin/vitest.cmd run packages/experimental/work-validation/tests
node_modules/.bin/tsc.cmd -b packages/experimental/work-validation
```

The provider test is skipped unless `DSH_VALIDATION_MODEL` is set. Supply `DSH_VALIDATION_URL`, `DSH_VALIDATION_KEY` through the environment, `DSH_VALIDATION_REPORT` as an output JSONL path and optionally `DSH_VALIDATION_TRIALS` (default 2). Run `provider.spec.ts` alone. It alternates baseline/enabled order with identical model, prompt, tools, output cap and fixture content per pair. A fresh random receipt must be obtained through a real PowerShell call and used in the final response. This is a transport/evidence smoke, not a general coding benchmark. Null metrics are unavailable, not zero. Do not commit credentials or private transcripts.

For generated coding diagnostics, additionally set `DSH_VALIDATION_BENCHMARK=1` and run `benchmark.spec.ts` alone. It covers success, failed test, missing dependency, change after green, invalid call correction, absent check, and exhausted correction budget. Each paired fixture uses identical generated bytes and hidden inputs. Two trials (28 arms) run by default; `DSH_VALIDATION_SCENARIOS` optionally selects comma-separated scenario names. Use the same environment for other OpenAI-compatible endpoints and model IDs. The experiment uses 8,192 context, 2,048 output tokens, low reasoning, 8 steps and 90 seconds per arm. Warm/load the chosen model first; do not run heavy builds concurrently with timing measurements.

The JSONL records include run/pair identifiers, reproducible fixtures, independent hidden outcomes, regressions against initially passing hidden assertions, invalid calls, explicit-success heuristic flags, timing and reported token counts. A scenario intentionally requiring failure should not be scored as a coding failure. Hidden tests only assess the generated function, not arbitrary application quality. The success-claim metric is a heuristic; manually review the recorded prose. Provider failure before any generation fails the benchmark and is not evidence of model quality. A passing Vitest benchmark means the measurement ran, not that the model solved every problem. Generated fixtures include no private project files; keep API credentials outside the report.

## Model Experience

### Project checks and computed report

#### What the model sees

Sourced `work-validation` context lists configured commands and computed verification statuses. It asks for an answer consistent with recorded evidence and permits explicit incomplete work. Model or provider names do not affect these rules.

#### Token effect

One configuration context per turn and bounded correction reports, proportional to at most 32 configured checks. Execution output is retained in the audit event rather than duplicated into every model request.

#### KV Cache effect

Append-only sourced context preserves earlier request prefixes. Provider caching availability is independent of the plugin.

## Known Limitations and Deferred Work

- Success-claim detection recognizes common explicit English/French phrases; it is not a semantic proof of arbitrary prose. Custom check names need careful interpretation. A successful test command can itself contain false tests.
- A raw integration schema outside the existing validator's supported JSON Schema subset is denied with `UNSUPPORTED_TOOL_SCHEMA` when enabled; it is not silently executed without validation.
- Required commands and source exclusions must be reviewed by the project owner. Observation cannot exclude a change-and-revert between scans, nor cover dependencies outside the configured project. Concurrent work may conservatively invalidate a check.
- Duration includes dispatch preparation; it is not pure process CPU time. Spill retention follows the shell provider; a missing or capped spill cannot be reconstructed by this plugin.
- No dedicated checklist UI is provided: reports use existing context cards. Real multi-model coding benchmarks and hidden-test quality must be reported separately from scripted integration tests and the live receipt smoke.

### Dev Note

None.
