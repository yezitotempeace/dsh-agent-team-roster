# dsh-agent-team-roster

[dsh](https://github.com/deepseek-ai) 的 Agent Teams 名册管理插件：**最新在最上**的显示顺序、
**一键批量清理**，以及成员**改名 / 删除**。不修改上游代码，作为单个 Cordis bundle 行安装。

[中文](#中文) · [English](#english) · [详细英文文档](README.en.md)

---

## 中文

### 功能

| 工具 | 作用 |
|---|---|
| `rename_teammate { target, new_name }` | 原地改名：保留历史、会话、任务与未投递消息；新名字成为它的地址 |
| `delete_teammate { target }` | 结束该成员当前回合、释放运行时、释放其未完成任务、丢弃未投递消息、释放名字 |
| `cleanup_team { scope }` | 批量清理，`scope` 为 `teammates` / `tasks` / `all` |

**批量清理的语义**：已结算（inactive/failed）成员会被删除；已完成任务会被删除。
以下会被**跳过并报告**在 `skipped[]`（含原因），不会被误删：
运行中的成员、仍在 provisioning 的成员、未完成的任务、仍阻塞着别的任务的任务。
只有 Team Lead 能调用以上三个工具。

**显示顺序**：团队名册、共享任务板、子智能体对话目录均为**最新在最上**；
Lead 行固定第一（它是当前会话的锚点，不是子成员）。

### 实现方式（不修改上游包）

- **改名 / 删除**：扩展已注册的 `agentTeam` 投影单元的 `def.apply`，把两种变更表达为
  既有 `team/member` 事件的新取值（`renamedTo` 字段 / `phase: "removed"`），
  因此名册、邮箱、任务板、工具、客户端视图全部照常读到变更。
- **显示顺序**：包装 `agentTeam` 与 `subagentCatalog` 的 `def.wire.view`——那是客户端实际收到的值
  （上游按 `wire.viewSchema.parse(wire.view(state))` 生成，冷会话的 `viewCheckpoint` 也走同一路径）。
  有序值以**打包视图的引用**为键做 `WeakMap` 记忆化，保持上游「单元自身忽略的变化不重复发布」的契约。
- **不变量**：投影状态、`stateVersion`、存储值、以及面向模型的服务契约
  （`list_agents` / `team_task_list` 仍按上游顺序返回）一律不变；倒序只影响客户端可见视图。

### 安装（dsh profile）

1. 把本仓库放到任意目录，例如 `/root/dsh-agent-team-roster`
2. 在 profile 的 `package.json` 依赖中加入：
   `"dsh-agent-team-roster": "link:/root/dsh-agent-team-roster"`
3. 在该 profile 的 bundle 插件列表中加入 `"dsh-agent-team-roster"`
4. 若该 profile 是 `patchReload: startup`，重启 dsh 服务后生效

### 测试

```bash
node test/build-pristine.mjs   # 从已安装的 dsh 生成上游模块副本并校验哈希
node test/run-tests.mjs        # 64 通过 / 0 失败
node test/run-wiring.mjs       # 14 通过 / 0 失败
node test/run-mount.mjs        # mount: ok（真实 ToolRuntime + SystemPrompt + 真实 Team 服务）
```

测试需要本机已安装 `@deepseek-ai/dsh`；**本仓库不包含任何上游代码**，
`test/core-pristine.js` 由 `build-pristine.mjs` 在本地生成（已加入 `.gitignore`）。

### 验收记录

本插件经过一名独立的第三方智能体两轮验收（它自己写脚本、自己下断言）：
功能主张 A–F 全部证实；第一轮查出的一处缺陷（包装后的视图破坏上游引用记忆化契约，
导致纯邮箱变更多发布一次）已修复，并在第二轮复验通过——纯 mailbox 事件的发布序列与
未安装插件时逐字节一致。

### 边界（如实说明）

- **已删除成员的子会话无法物理删除**：dsh 没有会话删除 API。清理覆盖名册行与共享任务；
  子智能体目录只有顺序生效。
- 倒序只作用于客户端可见视图；面向模型的 `list_agents` / `team_task_list` 保持上游顺序。
- 仅适配 dsh `0.2.0-rc.2`（依赖 `sessionProjections.registrations`、`journal` 等内部接缝）。
  上游结构变化时插件会在激活阶段**显式报错**，而不是静默降级。
- 像素级渲染无法在无浏览器的环境验证：已验证的是宿主交给客户端的值 +
  上游客户端对该值不做二次排序 + 人工观察。

### 许可

MIT，见 [LICENSE](LICENSE)。本仓库不包含上游 dsh 代码。

---

## English

### What it adds

| Tool | Effect |
|---|---|
| `rename_teammate { target, new_name }` | Rename in place: history, session, tasks and undelivered mail are kept; the new name becomes its address |
| `delete_teammate { target }` | Stop the member's current turn, release its runtime and unfinished shared tasks, drop undelivered mail, free the name |
| `cleanup_team { scope }` | Bulk cleanup; `scope` is `teammates`, `tasks`, or `all` |

**Cleanup semantics**: settled (inactive/failed) teammates and completed tasks are deleted.
Running teammates, teammates still provisioning, unfinished tasks, and tasks that still block
another task are **skipped and reported** in `skipped[]` with a reason, never deleted by mistake.
Only the Team Lead can call these tools.

**Display order**: the Team roster, the shared task board, and the subagent conversation catalog
render **newest first**; the Lead row stays pinned first because it anchors the current conversation.

### How it works (no upstream package is modified)

- **Rename / delete** extend the registered `agentTeam` projection unit's `def.apply`, expressing
  both mutations as new values of the existing `team/member` event (`renamedTo`, `phase: "removed"`),
  so every existing reader — roster, mailbox, task board, tools, client view — sees the change.
- **Display order** wraps `def.wire.view` of `agentTeam` and `subagentCatalog` — the value the client
  actually receives (upstream builds it as `wire.viewSchema.parse(wire.view(state))`, and cold-session
  `viewCheckpoint` reads go through the same path). The ordered value is memoized by the packaged
  value's reference in a `WeakMap`, preserving the upstream contract that a change the unit itself
  ignores republishes nothing.
- **Invariants**: fold state, `stateVersion`, stored values, and the model-facing service contracts
  (`list_agents` / `team_task_list` keep the packaged order) are unchanged; ordering is display-only.

### Install (dsh profile)

1. Place this repository anywhere, e.g. `/root/dsh-agent-team-roster`
2. Add `"dsh-agent-team-roster": "link:/root/dsh-agent-team-roster"` to the profile's `package.json` dependencies
3. Add `"dsh-agent-team-roster"` to that profile's bundle plugin list
4. Restart dsh when the profile uses `patchReload: startup`

### Tests

```bash
node test/build-pristine.mjs   # materialize the installed upstream module and verify its hash
node test/run-tests.mjs        # 64 passed / 0 failed
node test/run-wiring.mjs       # 14 passed / 0 failed
node test/run-mount.mjs        # mount: ok (real ToolRuntime + SystemPrompt + real Team service)
```

Tests require an installed `@deepseek-ai/dsh`. **This repository contains no upstream code**:
`test/core-pristine.js` is generated locally by `build-pristine.mjs` and is git-ignored.

### Verification record

An independent third-party agent verified this plugin in two rounds, writing its own scripts and
assertions: claims A–F all confirmed. The one defect it found in round one — the wrapped view broke
the upstream reference-memoization contract, publishing one redundant event for mailbox-only
changes — was fixed and re-verified in round two, with mailbox-only publish sequences now
byte-identical to a run without the plugin.

### Limits (stated plainly)

- **A deleted member's child conversation cannot be physically deleted**: dsh exposes no
  session-deletion API. Cleanup covers the roster row and shared tasks; only ordering applies to the
  conversation catalog.
- Ordering is display-only; the model-facing `list_agents` / `team_task_list` keep the packaged order.
- Verified against dsh `0.2.0-rc.2` only (it depends on internal seams such as
  `sessionProjections.registrations` and `journal`). When upstream changes shape the plugin **fails
  loudly** at activation instead of degrading silently.
- Pixel-level rendering cannot be verified without a browser: what is verified is the host-side value
  the client receives, the upstream client rendering it without re-sorting, and human observation.

### License

MIT, see [LICENSE](LICENSE). No upstream dsh code is included.
