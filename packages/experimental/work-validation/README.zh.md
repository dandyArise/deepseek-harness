---
description: "为开发 Agent 提供可选的执行证据和有界验证纠正。"
kind: "package-reference"
---

# @deepseek-ai/dsh-work-validation

[English](README.md) | 中文

## 概述

本实验插件通过现有工具管线、文件系统、Session 日志和停止钩子记录验证证据，不自行执行命令或授予权限。使用 `dsh-tools` 校验器和单调 guard，也覆盖不经过 `defineTool` 的原始工具；无效参数返回 `INVALID_ARGS`。工具名和作用域由原注册表负责。默认关闭；在可信配置中加载并设置 `enabled: true`。

## 目录

- [Configuration](#configuration)
- [证据与最终答复](#evidence-and-final-answers)
- [重现检查](#reproduce-checks)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration

本地源码配置示例：

```yaml
- insert:
    - id: work-validation
      name: 'D:/Github/Projets/IA/deepseek-harness/packages/experimental/work-validation/src/index.ts'
      config:
        enabled: true
        maxCorrections: 2
        maxValidationSteps: 4
```

在项目目录创建 `.harness-validation.json`，列出 `checks`：每项包含 `id`、`command`、可选 `cwd` 和 `required`。缺少命令时使用 `null`，状态为未执行。没有文件时读取 package.json 中的 test、typecheck、lint 和 build 脚本。命令与目录必须精确匹配。

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

`mode` 为 development、inspection 或 auto。inspection 不强制继续；auto 在文件发生变化或出现明确成功声明时检查。`maxCorrections` 默认 2，首次报告后 `maxValidationSteps` 默认 4。指纹扫描默认最多 10,000 个文件、64 MiB；无法完整观察时不得判为成功。英文文档包含可直接使用的配置示例和重现命令。

<a id="evidence-and-final-answers"></a>
## 证据与最终答复

前台 PowerShell 和 Bash 执行记录命令、目录、退出码、耗时、输出及截断日志路径。后台作业不算已完成验证。SHA-256 覆盖文件路径和内容，在命令前后及最终报告时检查，包括 shell 修改和外部修改。状态为 passed、failed、not-run、stale；退出码零只证明对应检查。

证据使用可忽略的 `plugin:work-validation/*` 日志，未加载插件的读取器仍可保留它们。投影保留每项最新证据。每次停止检查都会提供当前结果；只有检测到缺乏证据的成功声明才请求新一轮生成。纠正次数有限，有证据的成功报告和诚实的未完成报告可直接结束，无需强制重写，也不绕过审批。

当可选的 `repeat-tool-reminder` 提醒进入步骤时，插件在下一次生成前提供最新检查状态和配置的命令。它不会自行执行检查、否决工具或覆盖仅检查任务。这弥补了模型反复调用工具而未到达最终答复时的反馈缺口；模型是否遵守仍需真实评估。

<a id="reproduce-checks"></a>
## 重现检查

```powershell
node_modules/.bin/vitest.cmd run packages/experimental/work-validation/tests
node_modules/.bin/tsc.cmd -b packages/experimental/work-validation
```

`tests` 包含脚本化行为测试、真实 Loader 组合、可选真实供应商回执测试，以及七种生成式问题的成对比较。真实测试使用环境变量提供模型、地址和密钥。默认每种问题两次，交替启用和禁用插件；隐藏测试不放在模型工作区。指标包含隐藏结果、回归、无效调用、成功声明启发式、时长和可用 token 用量。空指标不是零；测试程序成功不等于模型全部解题成功。

## Model Experience

### 验证报告

#### What the model sees

带来源的上下文提供检查配置和由证据计算的状态，允许说明未完成事项。

#### Token effect

每轮一次配置，最多 32 项检查，纠正报告数量有界；不重复注入完整命令日志。

#### KV Cache effect

追加上下文保留已有前缀；缓存是否可用取决于供应商。

## Known Limitations and Deferred Work

- 成功声明检测仅为英法常见短语启发式，不能证明任意自然语言；测试命令也可能包含无效测试。
- 启用后，不支持的原始工具 JSON Schema 返回 `UNSUPPORTED_TOOL_SCHEMA`，不会跳过校验直接执行。
- 扫描不是全目录原子快照，无法发现两次观察之间的修改再还原；项目外依赖不在覆盖范围内。
- 排除目录和命令由项目所有者审核；日志完整性依赖 shell 的保留策略。
- 尚无专用检查列表 UI，使用现有上下文卡片。真实多模型质量评估必须与模拟测试区分。

<a id="dev-note"></a>
### 开发备注

无。
