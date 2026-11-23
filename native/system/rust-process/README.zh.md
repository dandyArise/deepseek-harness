# Rust 实现的 Windows 进程清理

[English](README.md) | 中文

可选的 Windows 专用 DLL，供 subprocess-local 检查进程身份和存活状态，
并强制清理终端进程树。通过绝对路径
`DANDY_WINDOWS_PROCESS_DLL` 启用。未设置时继续使用
现有实现。无效库配置或清理失败会明确报错。

这不会替代普通命令启动：现有 Windows Job
Object 隔离仍具权威性。终端优雅关闭仍由
现有运行时处理。Rust 替代强制进程树终止路径，避免
启动 taskkill 子进程，并通过持有的进程句柄核对创建身份。
DLL 在清理完成前保留已观察到的句柄，检查后续进程表
以发现晚创建的子进程，并等待异步终止完成，
不重复发出终止。超时为五秒；报错绝不代表清理已被证实。

ConPTY 初始可能给出 PID 零。终端句柄会读取当前
PID，并在首次输出时捕获初始身份，仅执行一次。

## 构建与复现（仓库根目录，Windows PowerShell）

```powershell
cargo +stable-x86_64-pc-windows-msvc build --release --locked --manifest-path native/system/rust-process/Cargo.toml
pnpm exec vitest run packages/subprocess/subprocess-local/tests/rust-process.windows.spec.ts packages/subprocess/subprocess-local/tests/windows-inspector.spec.ts
pnpm exec tsx native/system/rust-process/verify.ts process-comparison.json
$env:DANDY_WINDOWS_PROCESS_DLL = (Resolve-Path native/system/rust-process/target/release/dandy_process.dll).Path
```

真实测试需要 DLL，否则跳过。测试启动私有的
三进程 fixture（测试前置数据），停止或释放终端，并取消普通命令，
随后检查所有已观察到的进程身份。基准交替执行 10 次旧实现
和 10 次 Rust，保护一个无关哨兵进程，测试身份不匹配
以及重复终止。它记录全部样本并要求没有存活进程。

## 测量——2026-11-20，本地 Windows，Node 24.22.3

最终两组各 20 棵进程树通过，已观察到的后代没有存活：

| 中位数 | 旧实现 | Rust |
| --- | ---: | ---: |
| 强制清理，第 1 组 | 168.35 ms | 26.53 ms |
| 强制清理，第 2 组 | 163.79 ms | 17.69 ms |
| Node 堆增量，第 2 组 | 88,320 bytes | 3,032 bytes |
| Node RSS 增量，第 2 组 | 0 bytes | 0 bytes |

这些是本地微基准，不是端到端终端停止延迟（后者
包括优雅关闭）。堆增量是未强制 GC 的噪声分配数据，
不包含外部 taskkill 进程，也不代表保留内存。尚未证明
Harness 总体内存降低。第 1 组执行时构建检查还在
结束阶段。两种实现使用相同 fixture、交替顺序并验证退出。

16 个针对性测试通过；更广的 subprocess-local 测试：189 通过、23 跳过，
2 个因 Windows 拒绝创建符号链接而失败（原有 spawn-runner
测试中的 EPERM）。Host/client 构建检查与构件通过；Rust Clippy 通过。

限制：已观察到的后代树不能保证约束在观察前
已逃逸或更换父进程的子进程。普通命令保留更强的
Job 所有权。这里没有测试 GUI 点击、宿主突然崩溃以及每一种
权限或安全配置。未停止任何用户进程或模型。
