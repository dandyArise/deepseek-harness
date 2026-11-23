# Dandy Rust 内核——已测量，显式启用

[English](README.md) | 中文

这个私有 Rust crate 不具备文件系统或执行能力。它导出
带版本号的 WebAssembly ABI，由 `@deepseek-ai/node-addon-system/kernels` 使用。
经典引擎可用它进行结构化 Zstandard 帧索引以及
纯压力阈值计算。会话字节、schema 验证、锁、
解压和事务写入仍由现有组件负责。

## 构建与比较

从引擎仓库根目录执行（需 Rust stable 和 `wasm32-unknown-unknown`）：

```powershell
cargo build --release --target wasm32-unknown-unknown --manifest-path native/system/rust-kernels/Cargo.toml
pnpm --dir native/system/packages/entry run build:js
node --test native/system/test/kernels.test.js
node --import tsx/esm native/system/rust-kernels/verify.mjs
```

在**启动引擎之前**将 `DANDY_RUST_KERNELS` 设为生成的
`target/wasm32-unknown-unknown/release/dandy_kernels.wasm`
绝对路径以启用。取消设置则使用现有实现。显式指定的
无效构件会报错，不会静默假装已使用 Rust。
默认桌面启动器不启用此实验。

只有可信的管理员或用户控制的配置才可选择构件。
模块没有导入。缓存实例前会检查 ABI 版本 1、导出的内存
以及所有必需函数。不完整的导出会产生
明确的 ABI 错误。临时输入副本
限制为 64 MiB；更大输入使用原有 TS 扫描器。截断尾部、
无效头部、保留位和帧数量限制保留现有语义。
不进行会话迁移或重写。

## 测量——2026 年 11 月 20 日

四次预热后执行二十组交替配对，使用同一合成的 1,000 帧语料、
97,243 个压缩字节和 Windows 上的 Node。每个索引样本取 100 次调用的平均值。
254 个差分案例涵盖有效帧、截断尾部、损坏、限制
与预算。选择 Rust 后，生产 zstd/compaction 测试也通过。

| 操作（含桥接） | TS 中位数 | Rust/WASM 中位数 | 决策 |
|---|---:|---:|---|
| 帧索引 | 0.01347 ms | 0.01718 ms | 默认保留 TS |
| 压力阈值 | 0.00000333 ms | 0.00037221 ms | 默认保留 TS |

这些是微基准，不是启动、聊天可用时间或总内存结果。
WASM 复制输入并重建 JS 结果对象。不宣称 RSS 降低。
压缩和解压已通过 Node 使用原生 Zstandard；
这些测量不足以支持在这里重复实现。此次增量尚未移植
完整 JSON 解析、恢复或会话查询。
