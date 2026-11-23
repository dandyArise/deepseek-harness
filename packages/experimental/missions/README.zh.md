---
description: "配置具有持久结果与显式角色权限的有界多模型任务。"
kind: "package-reference"
---

# Missions（实验性）

[English](README.md) | 中文

## 概述

可选的 mission 任务适用于研究、分析、写作与开发。协调者仍为现有根 agent（智能体）。每个任务在新的本地子代理上运行，并使用显式配置的模型路由。根 agent 所选模型不会改变。

## 目录

- [配置与使用](#configuration-and-use)
- [持久性与取消](#durability-and-cancellation)
- [预算](#budgets)
- [验证](#verification)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration-and-use"></a>
## 配置与使用

在 profile 覆盖配置中显式加载 `@deepseek-ai/dsh-missions`。随附默认配置不包含它。必须具备本地 `spawn` 子代理提供方、工具、会话持久化和会话投影。

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

使用实际目录标识。路由由宿主控制，不会静默回退到另一提供方。`tools: []` 拒绝工作 agent 的全部工具执行。已配置的工具允许列表不会绕过现有批准或沙箱检查。只允许叶子工具；此首个增量不包含委派和跨 agent 通信。

`mission_task` 接受 `id`、`role`、`objective` 和非空 `acceptance` 条件。每个根会话同时只运行一个工作 agent。任务 id 是幂等键：重复相同请求返回保存的状态，改变其约定则失败。新 id 启动新工作并消耗另一个任务名额。子代理显示在现有目录中，并保留完整对话。

`mission_results` 读取 mission。提供 `id` 会取回并确认保存的结果，绝不启动模型。`retrieved` 记录本地确认，不表示外部客户端已收到。执行状态与交付状态分离。全部结果保持 `unverified`：LLM（大语言模型）轮次结束不等于独立验证。

<a id="durability-and-cancellation"></a>
## 持久性与取消

版本一的 `plugin:missions/state` 记录保存在协调者会话日志中，使用现有持久化与检查点机制。准入必须在派发前完成 flush。flush 失败会停止派发；已追加记录仍可见，重试前必须检查。不支持或损坏的记录会安全失败，而非重置预算。

失去执行所有权后，已保存的运行中任务在读取时变为 `interrupted`。不会自动重放。在显式请求新工作前检查其子会话。取回已完成工作不会重新执行效果。任务截止时间会取消确切的 activation 并等待其清理，不会终止无关 agent。卸载插件会取消并等待其拥有的工作。

保存的输出受 `maxResultChars` 限制，`truncated` 和 `childId` 指向完整子会话。未知失败使用通用诊断，不把提供方 payload 复制进 mission 记录。

<a id="budgets"></a>
## 预算

首个任务为根会话捕获限制。后续配置更改不会重置累计步骤或任务数。每个子步骤在准入前都会预留并 flush。输出 token 通过现有 agent 选项按模型请求限制。截止时间包括启动与生成；步骤内的提供方重试受截止时间约束，不作为独立步骤计数。

<a id="verification"></a>
## 验证

从仓库根目录执行：

```powershell
node node_modules/vitest/vitest.mjs run packages/experimental/missions/tests
node --import tsx scripts/build.ts --scope artifacts
node --import tsx scripts/build.ts --scope check
```

运行时测试模拟派发与持久化失败。Loader 测试使用真实 Harness 组合、会话、子代理和工具保护，配合脚本化 LLM 适配器；它不是真实提供方基准。

当 `MISSIONS_LIVE_KEY` 包含 AxForge 凭据时，可选的 `tests/live.spec.ts` 执行。它使用脚本化协调者与真实 `qwen3.8-flash-next` 工作 agent，检查一次带不可预测回执的结构化工具调用，并重启 Harness 以取回结果而不再次运行工作 agent。它不会更改桌面 profile 或加载本地模型。凭据保留在环境变量中，绝不写入覆盖配置。

2026-11-19 的测量：一次真实测试通过（包括两次启动共 15.47 秒）；十个本地测试通过。随后一次真实重复调用了工具，但返回 `mission_probe` 而非不可预测回执，因此断言正确失败。真实行为尚未稳定验证，此功能仍需显式启用。这些试验不能证明推理质量提高，也不是完整的双真实模型协作基准。

<a id="model-experience"></a>
## 模型体验

### Mission 工具与任务提示

#### 模型看到什么

协调者看到已配置的角色名称与模型路由、任务准入错误和 JSON 执行报告。工作 agent 收到 `objective`、`acceptance`，以及报告来源、证据和限制的指令，不得宣称独立验证或委派。工具结果和工作 agent 输入使用现有日志通道。

#### Token 影响

仅启用时添加两个工具 schema。每个任务使用独立子上下文。结果文本受已保存字符限制约束；这不是 token 估算。

#### KV Cache 影响

工作 agent 使用新对话。协调者工具结果追加到其历史。缓存是否可用仍由提供方决定。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- 这是首个基础增量，不是完整 Missions 产品。并行调度、依赖图、带版本的共享构件、自动规划、独立验证和专用设置/UI 仍待实现。
- 尚无累计计费 token 或金额上限。已强制的预算包括任务数、准入步骤、墙钟取消和单次请求输出上限。提供方用量仍可通过现有子会话统计获得；不可用时不会编造。
- 同角色工具属于可信宿主配置。这是额外的工具允许列表，不替代进程隔离或授权系统。
- 中断工作需要检查并显式发起新工作；不宣称任意外部动作具备自动恰好一次恢复。
- 不自动加载模型、驱逐 GPU 模型或回退到付费提供方。

<a id="dev-note"></a>
### 开发备注

无。
