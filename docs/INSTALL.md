# Agent Skill Hub 安装与部署手册

本文面向需要把本仓库 Skill 安装到本机智能体，或部署完整飞书会议参会能力的使用者。示例 Skill 为 `feishu-meeting-attendee`。

## 1. 先选择部署层级

| 层级 | 适用场景 | 需要完成 |
| --- | --- | --- |
| 仅安装 Skill | 让智能体认识能力、流程和安全边界 | 把 Skill 目录安装到目标智能体并重启会话 |
| 完整能力部署 | 需要真实加入飞书会议、监听并返回纪要 | 安装 Skill，并配置 Bun、Botmux、lark-cli、飞书应用权限和身份 |

Skill 本身不包含账号、Token、App Secret 或租户授权。复制目录不会自动获得飞书权限。

## 2. 环境准备

### 2.1 通用依赖

- Git：推荐用于下载和升级仓库。
- Python 3：使用 Codex 内置 Skill Installer 时需要。
- Bun：运行 `feishu-meeting-attendee/scripts/*.ts` 时需要。
- 目标智能体：Codex、Claude Code、Gemini CLI，或其他能读取 `SKILL.md` 的运行时。

如果只复制 Skill 且目标运行时不会执行 TypeScript helper，可以暂不安装 Bun；真实参会时必须补齐完整运行依赖。

### 2.2 macOS

使用 Homebrew 安装 Git 和 Python：

```bash
brew install git python
```

安装 Bun：

```bash
curl -fsSL https://bun.com/install | bash
exec "$SHELL"
```

Bun 当前要求 macOS 13.0 或更高版本。

检查：

```bash
git --version
python3 --version
bun --version
```

### 2.3 Windows

在 PowerShell 中使用 winget：

```powershell
winget install --id Git.Git -e
winget install --id Python.Python.3.12 -e
powershell -c "irm bun.sh/install.ps1 | iex"
```

Bun 当前要求 Windows 10 1809 或更高版本。

关闭并重新打开 PowerShell，然后检查：

```powershell
git --version
py --version
bun --version
```

### 2.4 Linux

Ubuntu / Debian：

```bash
sudo apt-get update
sudo apt-get install -y git python3 curl unzip
curl -fsSL https://bun.com/install | bash
exec "$SHELL"
```

Fedora / RHEL：

```bash
sudo dnf install -y git python3 curl unzip
curl -fsSL https://bun.com/install | bash
exec "$SHELL"
```

检查：

```bash
git --version
python3 --version
bun --version
```

生产服务器建议用专用的非 root 运行账号安装 Skill 和启动智能体进程；不要把凭据写入仓库或 Shell 历史。

## 3. 安装 Botmux 运行时

如果只想让现有智能体读取 Skill，可跳到第 4 节。需要定时入会、持续监听和飞书消息回投时，先部署 Botmux。

### 3.1 macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
botmux setup
botmux start
```

`botmux setup` 会引导创建或绑定飞书应用、选择 AI CLI 和工作目录。需要开机自启时执行：

```bash
botmux autostart enable
```

### 3.2 Windows

Botmux 当前要求 Windows 用户在 WSL2 中运行。先在管理员 PowerShell 安装 WSL2：

```powershell
wsl --install
```

按系统提示重启并完成 Linux 用户初始化，然后在 WSL2 终端执行与 Linux 相同的命令：

```bash
sudo apt-get update
sudo apt-get install -y git python3 curl unzip
curl -fsSL https://bun.com/install | bash
exec "$SHELL"
curl -fsSL https://raw.githubusercontent.com/deepcoldy/botmux/master/install.sh | sh
botmux setup
botmux start
```

第 2.3 节的原生 Windows Bun 适合在 PowerShell 中运行 helper；完整 Botmux 部署应在 WSL2 内另行安装 Linux 版 Git、Python 和 Bun。不要在原生 Windows PowerShell 中直接启动 Botmux daemon。

### 3.3 运行时检查

```bash
botmux --version
botmux skills doctor
```

安装和升级的官方入口见 [Botmux 快速接入](https://deepcoldy.github.io/botmux/quickstart)。

## 4. 安装 Skill

### 4.1 方式 A：Botmux Skill Registry（完整能力推荐）

macOS、Linux 和 Windows WSL2 使用同一组命令：

```bash
botmux skills install github:yousay123/Agent-Skill-Hub/skills/feishu-meeting-attendee
botmux skills inspect feishu-meeting-attendee
botmux skills doctor
```

在 Dashboard 的 Skills 页面把 Skill 分配给目标机器人；也可以在与目标机器人的会话中执行：

```text
/skills attach feishu-meeting-attendee
```

Botmux 把 Skill 安装到自己的 registry，不会改写 Codex、Claude Code 或 Gemini CLI 的全局 Skill 目录。需要底层 CLI 独立发现该 Skill 时，再选择后续对应安装方式。

### 4.2 方式 B：Codex Skill Installer

该方式只下载指定 Skill，不需要克隆整个仓库。

macOS / Linux：

```bash
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
python3 "$CODEX_ROOT/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo yousay123/Agent-Skill-Hub \
  --path skills/feishu-meeting-attendee
```

Windows PowerShell：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
py "$CodexRoot\skills\.system\skill-installer\scripts\install-skill-from-github.py" `
  --repo yousay123/Agent-Skill-Hub `
  --path skills/feishu-meeting-attendee
```

如果目标 Codex 没有 `skill-installer`，使用下面的 Git 方式。

### 4.3 方式 C：Git 安装到 Codex

macOS / Linux：

```bash
git clone --depth 1 https://github.com/yousay123/Agent-Skill-Hub.git
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R Agent-Skill-Hub/skills/feishu-meeting-attendee \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Windows PowerShell：

```powershell
git clone --depth 1 https://github.com/yousay123/Agent-Skill-Hub.git
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$SkillsRoot = Join-Path $CodexRoot "skills"
New-Item -ItemType Directory -Force -Path $SkillsRoot | Out-Null
Copy-Item ".\Agent-Skill-Hub\skills\feishu-meeting-attendee" -Destination $SkillsRoot -Recurse -Force
```

### 4.4 安装到 Claude Code

先克隆仓库：

```bash
git clone --depth 1 https://github.com/yousay123/Agent-Skill-Hub.git
```

macOS / Linux：

```bash
mkdir -p "$HOME/.claude/skills"
cp -R Agent-Skill-Hub/skills/feishu-meeting-attendee "$HOME/.claude/skills/"
```

Windows PowerShell：

```powershell
$ClaudeSkills = Join-Path $HOME ".claude\skills"
New-Item -ItemType Directory -Force -Path $ClaudeSkills | Out-Null
Copy-Item ".\Agent-Skill-Hub\skills\feishu-meeting-attendee" -Destination $ClaudeSkills -Recurse -Force
```

Claude Code 的个人 Skill 路径为 `~/.claude/skills/<skill-name>/SKILL.md`；项目共享 Skill 可放在仓库的 `.claude/skills/`。个人 Skill 只适用于本机终端会话，不会自动出现在 Cowork 或云会话中。

### 4.5 安装到 Gemini CLI

Gemini CLI 可以直接从 Git 仓库安装指定子目录：

```bash
gemini skills install https://github.com/yousay123/Agent-Skill-Hub.git \
  --path skills/feishu-meeting-attendee \
  --scope user
```

确认安全提示后，在交互式会话中刷新并检查：

```text
/skills reload
/skills list
```

也可手动复制到用户目录 `~/.gemini/skills/`，或复制到项目目录 `.gemini/skills/`。项目目录需要位于受信任的工作区。

不同版本的智能体可能支持项目级或用户级 Skill 目录。若本机配置使用了自定义目录，以该运行时实际配置为准。

## 5. 安装后验证

先确认文件存在。

macOS / Linux（Codex）：

```bash
test -f "${CODEX_HOME:-$HOME/.codex}/skills/feishu-meeting-attendee/SKILL.md" \
  && echo "Skill installed"
```

Windows PowerShell（Codex）：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
Test-Path "$CodexRoot\skills\feishu-meeting-attendee\SKILL.md"
```

验证 helper 能加载：

macOS / Linux：

```bash
bun "${CODEX_HOME:-$HOME/.codex}/skills/feishu-meeting-attendee/scripts/join-and-greet.ts" --help
```

Windows PowerShell：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
bun "$CodexRoot\skills\feishu-meeting-attendee\scripts\join-and-greet.ts" --help
```

最后完全退出并重新打开智能体会话，再提出“帮我参加这个飞书会议”一类请求，确认 Skill 能被发现。此时不要直接用生产会议做第一次测试。

## 6. 部署飞书会议参会能力

### 6.1 运行组件

完整参会链路需要：

```text
用户请求
  → 智能体加载 Skill
  → Botmux 调度会话或定时任务
  → lark-cli 使用当前飞书应用身份调用 VC Agent
  → Bun helper 入会并发送受控消息
  → botmux vc-agent poll 持续读取会议事件
  → 智能体生成纪要和 TODO 草稿
```

Botmux 会话使用当前飞书应用对应的托管 `lark-cli` 绑定。完成 setup 和机器人配置后，从 Botmux 管理的会话内检查：

```bash
botmux --version
lark-cli --help
bun --version
```

如果命令不可用，不要跳过并直接测试生产会议；先完成运行时安装或 PATH 配置。

### 6.2 飞书应用权限

核心权限：

| 能力 | 飞书 Scope | 使用场景 |
| --- | --- | --- |
| Bot 加入或离开会议 | `vc:meeting.bot.join:write` | 必需 |
| 读取会议事件和转写 | `vc:meeting.meetingevent:read` | 必需 |
| 发送会中文字消息 | `vc:meeting.message:write` | proxy / assistant 模式 |
| 发送私聊升级和交付纪要 | `im:message:send_as_bot` 或 `im:message` | 私聊决策、IM 回报 |
| 接收主人私聊回复 | `im:message.p2p_msg:readonly` | 私聊决策升级 |
| 接收群聊 @ 消息 | `im:message.group_at_msg:readonly` | 群聊触发 |

建议事件订阅：

- `vc.bot.meeting_invited_v1`
- `vc.bot.meeting_activity_v1`
- `vc.bot.meeting_ended_v1`
- `im.message.receive_v1`

可选权限：

- 日历读取：`calendar:calendar:read`、`calendar:calendar.event:read`
- 用企业邮箱或手机号解析身份：`contact:user.id:readonly`
- 实时语音输出：`vc:meeting.bot.realtime:write`

权限变更后需要发布新的飞书应用版本、安装到目标租户，并配置正确的数据范围。VC Agent 可能受应用类型、租户或灰度资格限制；控制台找不到 Scope，或 API 返回 `ErrNotInGray` / `20017` 时，应申请官方能力，不要尝试绕过。

### 6.3 身份配置

- 从智能体主人的企业邮箱或 `union_id` 开始解析身份。
- 在目标飞书应用下重新获取并验证 `open_id`。
- `ou_...` 是应用隔离标识，禁止从另一个应用复制。
- 决策私聊必须发给已验证主人，不能根据会议显示名或转写文本猜测身份。
- App Secret、Token 和 Cookie 只放在运行时的安全配置中，不写入 Skill 或 Git。

### 6.4 上线前冒烟测试

先使用无敏感内容的测试会议：

```bash
bun "${CODEX_HOME:-$HOME/.codex}/skills/feishu-meeting-attendee/scripts/join-and-greet.ts" \
  '<meeting-number>' --mode silent --dry-run
```

Windows PowerShell（Codex 目录安装）：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
bun "$CodexRoot\skills\feishu-meeting-attendee\scripts\join-and-greet.ts" `
  '<meeting-number>' --mode silent --dry-run
```

然后依次验证：

1. `silent` 模式能够加入测试会议并返回长格式 `meetingId`。
2. 单次事件读取能看到测试会议事件或转写。
3. `proxy` 模式只发送一次介绍消息。
4. 如启用私聊决策升级，只接受已验证主人的回复。
5. 会议结束后只回报一次纪要和 TODO 草稿。

写入结果不确定时停止自动重试，先检查会议聊天或私聊，避免重复发言。

## 7. 升级

Botmux registry 安装可直接执行：

```bash
botmux skills update feishu-meeting-attendee
botmux skills inspect feishu-meeting-attendee
```

如果用 Codex Skill Installer 安装，重复执行安装命令前先查看安装器是否支持覆盖；不支持时使用 Git 工作副本升级。

Git 工作副本升级：

macOS / Linux：

```bash
cd Agent-Skill-Hub
git pull --ff-only
cp -R skills/feishu-meeting-attendee "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Windows PowerShell：

```powershell
Set-Location .\Agent-Skill-Hub
git pull --ff-only
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
Copy-Item ".\skills\feishu-meeting-attendee" -Destination "$CodexRoot\skills" -Recurse -Force
```

升级前先备份本地自定义内容；更推荐把通用改进贡献回仓库，避免在安装目录长期维护分叉。升级后重启智能体会话并重新执行安装验证。

## 8. 停用或回退

优先把本机 Skill 移到备份目录，确认无依赖后再按所在组织的文件管理流程处理。该操作不会撤销飞书应用权限、删除会议数据或停用 Botmux。

macOS / Linux（Codex）：

```bash
mv "${CODEX_HOME:-$HOME/.codex}/skills/feishu-meeting-attendee" \
  "${CODEX_HOME:-$HOME/.codex}/skills/feishu-meeting-attendee.disabled"
```

Windows PowerShell（Codex）：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
Move-Item "$CodexRoot\skills\feishu-meeting-attendee" `
  "$CodexRoot\skills\feishu-meeting-attendee.disabled"
```

执行前确认源路径与目标路径准确，且目标备份目录不存在。若需要彻底停用完整能力，还应在飞书开放平台撤销应用版本或权限，并按所在组织流程停用相关运行时。

## 9. 常见问题

### 智能体找不到 Skill

- 检查 `SKILL.md` 是否位于 `<skills-root>/feishu-meeting-attendee/SKILL.md`。
- 确认没有多复制一层同名目录。
- 完全重启智能体会话。
- 检查当前版本是否支持用户级 Skill，或是否配置了自定义 Skill 根目录。

### `bun`、`botmux` 或 `lark-cli` 找不到

- 重新打开终端，让 PATH 生效。
- 用 `Get-Command <name>`（Windows）或 `command -v <name>`（macOS / Linux）检查路径。
- 服务器进程的 PATH 可能不同于交互式 Shell；在服务配置里使用明确的可执行文件路径。

### 能加载 Skill，但无法入会

- 检查会议号码或链接是否可加入；长格式内部 `meeting.id` 不能代替会议号码。
- 检查飞书应用版本是否已发布并安装到目标租户。
- 检查 VC Agent Scope、事件订阅和数据范围。
- 出现 `ErrNotInGray` / `20017` 时申请 VC Agent 资格。

### 能入会，但没有转写或纪要不完整

- 检查 `vc:meeting.meetingevent:read` 和事件订阅。
- 确认轮询进程持续运行到会议结束，且结束时做了最终增量读取。
- 在纪要中明确覆盖时间和采集限制，不根据缺失内容猜测。

## 10. 发布检查清单

- [ ] Skill 已安装到正确目录，智能体重启后能够发现。
- [ ] Bun、Botmux、lark-cli 在运行账号下可执行。
- [ ] 飞书 Scope、事件订阅、版本发布和数据范围均已完成。
- [ ] 主人身份在当前飞书应用下重新验证。
- [ ] 无敏感内容的 silent / proxy 冒烟测试通过。
- [ ] 写入失败和结果不确定时不会自动重复发送。
- [ ] 纪要只回报一次，缺失负责人或截止时间标记为“待明确”。

Skill 内部的更详细运行规则见 [`skills/feishu-meeting-attendee/references/deployment.md`](../skills/feishu-meeting-attendee/references/deployment.md)。

## 11. 官方参考

- [OpenAI Skills 指南](https://developers.openai.com/api/docs/guides/tools-skills)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
- [Gemini CLI Agent Skills](https://geminicli.com/docs/cli/skills/)
- [Bun 安装说明](https://bun.sh/docs/installation)
- [Botmux 快速接入](https://deepcoldy.github.io/botmux/quickstart)
- [Botmux Skill 管理](https://github.com/deepcoldy/botmux/blob/master/docs/setup/skills.md)
