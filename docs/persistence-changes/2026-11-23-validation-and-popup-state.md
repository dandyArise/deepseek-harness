---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-23-validation-and-popup-state

English | [中文](2026-11-23-validation-and-popup-state.zh.md)

## Summary

Records work-validation context-form attribution in durable message slots and the previously unacknowledged parent-owned subagent popup archive, restore, automatic preference and display-name event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-23-validation-and-popup-state
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "5d7757525adbece5b336dc844818c6391c6c133dc9dd968f1c1817f7f450ed1f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "c74afe860d39cbdf6f482fb047c345aafd6cd0fa6c2bd74074fb2b4e26a04f7d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "f78a78c1bb29b4354990ad5133b7098b5ed032151fefdb9c7881a17c712c0a20"
    decision: same-version
  - root: "event:subagent/popup-archive"
    previous: null
    after: "aca5e80e90698fa9cffa4c7bac5515187eec802cf6dae3fd779ba0988ede23f5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "b8c1e9431391754db13095a64ac968f461e47428b2f88d093fff3f8bb27a47ac"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The Session header remains V4. Existing message alternatives and the work-validation source without a form remain admitted. New form metadata is attribution: the released V4 source reader validates the producer kind and preserves its JSON fields without requiring the producer plugin. This applies to user messages, developer messages, inbox insertions and the title request's log-only message list. The title request is not replayed as a new model request. The popup projection retains add, restore and auto payloads; names are optional in saved projection state and rename only changes parent-owned UI metadata, not child routing, history or usage. Against accepted history this is a new ordinary event. A V4 reader without its event vocabulary refuses it before artifact adoption rather than treating it as recoverable corruption or truncating it; with the vocabulary it retains the full payload. This does not promise that every intermediate fork's popup projection understands rename: callers must use the matching current projection. No historical checkpoint, header version, previous acknowledgement or user session is rewritten.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/codec.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts packages/subagent/subagent/tests/popup-archive.spec.ts: 59 tests passed. Coverage includes all declared work-validation forms in each durable message slot, payload round trips, no mutation on unknown-event refusal, and popup archive/restore replay. The focused work-validation and missions suites also passed in the local run (47 tests passed, 3 optional live-provider tests skipped together with popup tests). No live LLM or saved profile was changed. The structural base/head inventory comparison was inspected separately from this acknowledgement; historical intermediate fork executables were not run.

<a id="dev-note"></a>
## Dev Note

None.
