---
description: "Configure bounded multi-model tasks with durable results and explicit role permissions."
kind: "package-reference"
---

# Missions (experimental)

English | [中文](README.zh.md)

## Summary

Opt-in mission tasks for research, analysis, writing and development. The coordinator remains the existing root agent. Each task runs on a fresh local subagent with an explicitly configured model route. The root's selected model is never changed.

## Table of Contents

- [Configuration and use](#configuration-and-use)
- [Durability and cancellation](#durability-and-cancellation)
- [Budgets](#budgets)
- [Verification](#verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="configuration-and-use"></a>
## Configuration and use

Load `@deepseek-ai/dsh-missions` explicitly in a profile overlay. It is not included in shipped defaults. The local `spawn` subagent provider, tools, session persistence and session projections must be available.

```yaml
- insert:
    - id: missions
      name: '@deepseek-ai/dsh-missions'
      config:
        enabled: true
        roles:
          - name: analyst
            provider: your-provider-id
            model: your-model-id
            tools: []
        limits:
          maxTasks: 8
          maxSteps: 32
          taskSteps: 8
          taskSeconds: 120
          maxOutputTokens: 2048
          maxResultChars: 16000
```

Use actual catalog identifiers. Routes are host-controlled, with no silent fallback to another provider. `tools: []` denies all worker tool executions. A configured tool allowlist does not bypass existing approval or sandbox checks. Allow only leaf tools; delegation and cross-agent messaging are not part of this first increment.

`mission_task` accepts `id`, `role`, `objective`, and nonempty `acceptance` criteria. One worker runs at a time per root session. A task id is an idempotency key: repeating the same request returns its saved status, while changing its contract fails. A new id starts new work and consumes another task slot. The child appears in the existing subagent catalog and retains its complete conversation.

`mission_results` reads the mission. Supplying `id` retrieves and acknowledges a saved result; it never starts a model. `retrieved` records this local acknowledgement, not receipt by an external client. Execution status and delivery status are separate. All results remain `unverified`: completion of an LLM turn is not independent verification.

<a id="durability-and-cancellation"></a>
## Durability and cancellation

Version-one `plugin:missions/state` records live in the coordinator's session journal and use the existing persistence and checkpoint mechanisms. Admission must flush before dispatch. A flush failure stops dispatch; a record already appended remains visible and must be inspected before retrying. Unsupported or corrupt records fail closed instead of resetting budgets.

After loss of execution ownership, a saved running task becomes `interrupted` when read. It is not automatically replayed. Inspect its child conversation before explicitly requesting new work. Retrieving completed work does not re-execute effects. The task deadline cancels the exact activation and waits for its teardown; it does not kill unrelated agents. Unloading the plugin cancels and awaits its owned work.

Stored output is bounded by `maxResultChars`, with `truncated` and `childId` pointing to the complete child session. Unknown failures use a generic diagnostic instead of copying provider payloads into mission records.

<a id="budgets"></a>
## Budgets

The first task captures the limits for the root session. Later configuration changes do not reset accumulated steps or task counts. Each child step is reserved and flushed before admission. Output tokens are capped per model request through the existing agent option. The deadline includes startup and generation; provider retries inside a step are bounded by this deadline, not counted as separate steps.

<a id="verification"></a>
## Verification

From the repository root:

```powershell
node node_modules/vitest/vitest.mjs run packages/experimental/missions/tests
node --import tsx scripts/build.ts --scope artifacts
node --import tsx scripts/build.ts --scope check
```

The runtime tests simulate dispatch and persistence failures. The Loader test uses real Harness composition, sessions, subagents and tool guards with scripted LLM adapters; it is not a live-provider benchmark.

The optional `tests/live.spec.ts` runs when `MISSIONS_LIVE_KEY` contains an AxForge credential. It uses a scripted coordinator and a real `qwen3.8-flash-next` worker, checks one structured tool call with an unpredictable receipt, and restarts Harness to retrieve the result without running the worker again. It does not change the desktop profile or load a local model. Keep credentials in the environment, never in the overlay.

Measured on 2026-11-19: a live test passed (15.47 seconds including both boots); the ten local tests passed. A subsequent live repetition called the tool but returned `mission_probe` instead of the unpredictable receipt, so the assertion correctly failed. Live behavior is not consistently validated and the feature remains opt-in. These trials are not evidence of improved reasoning quality or a complete two-live-model collaboration benchmark.

<a id="model-experience"></a>
## Model Experience

### Mission tools and task prompt

#### What the model sees

The coordinator sees the configured role names and model routes, task admission errors, and JSON execution reports. The worker receives `objective`, `acceptance`, and the instruction to report sources, evidence and limits without claiming independent verification or delegating. Tool results and worker inputs use the existing logged channels.

#### Token effect

Two tool schemas are added only when enabled. Each task uses an independent child context. Result text is capped by the saved character limit; this is not a token estimate.

#### KV Cache effect

Workers use fresh conversations. Coordinator tool results append to its history. Cache availability remains provider-owned.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- This is the first foundation increment, not the complete Missions product. Parallel scheduling, dependency graphs, versioned shared artifacts, automatic planning, independent verification and a dedicated settings/UI view remain to implement.
- There is no aggregate billed-token or monetary ceiling yet. The enforced budgets are task count, admitted steps, wall-clock cancellation and per-request output cap. Provider usage remains available through existing child-session statistics; it is not invented when unavailable.
- Same-role tools are trusted host configuration. This is an additional tool allowlist, not a replacement for process isolation or the authorization system.
- Interrupted work requires inspection and explicit new work; automatic exactly-once recovery of arbitrary external actions is not claimed.
- No automatic model loading, GPU eviction or paid-provider fallback is performed.

<a id="dev-note"></a>
### Dev Note

None.
