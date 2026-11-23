---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-23-validation-and-popup-state

[English](2026-11-23-validation-and-popup-state.md) | 中文

## 概述

记录持久消息位置中的 work-validation 上下文形式归属，以及此前未确认的父会话子代理弹窗归档、恢复、自动归档偏好和显示名称事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

Session 头保持 V4。已有消息分支和不含 form 的 work-validation 来源仍可读取。新增 form 元数据仅用于归属：已发布 V4 来源读取器验证生产者 kind，并保留其 JSON 字段，无需加载生产者插件。这覆盖用户消息、开发者消息、收件箱插入和仅用于日志的标题请求消息列表；标题请求不会作为新模型请求重放。弹窗投影保留 add、restore 和 auto 载荷；保存状态中的 names 为可选字段，rename 只改变父会话 UI 元数据，不改变子代理路由、历史或用量。相对于已接受历史，这是新的普通事件。没有该事件词表的 V4 读取器会在接纳构件前拒绝它，而不将其当作可恢复损坏或截断日志；具有词表的读取器保留完整载荷。不保证每个中间 fork 的弹窗投影都理解 rename：调用方必须使用匹配的当前投影。不会重写历史检查点、头版本、既有确认记录或用户会话。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/codec.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts packages/subagent/subagent/tests/popup-archive.spec.ts：59 个测试通过。覆盖每个持久消息位置的所有已声明 work-validation 形式、载荷往返、未知事件拒绝时不修改数据，以及弹窗归档/恢复重放。本地 work-validation 与 missions 定向套件也通过（连同弹窗测试共 47 个通过，3 个可选真实供应商测试跳过）。未更改真实 LLM 或已保存配置。结构化 base/head 清单比较独立于本确认记录进行了检查；未运行历史中间 fork 的可执行文件。

<a id="dev-note"></a>
## 开发备注

无。
