# Agent Skill Hub 安装与部署手册

本文说明如何在 macOS、Windows 和 Linux 上安装本仓库的 Skill，并以 `feishu-meeting-attendee` 为例部署完整外部能力。仓库不绑定某一种智能体编排框架；只要宿主能发现 `SKILL.md`、运行辅助脚本并把结果交付给用户，即可接入。

## 1. 部署层级

| 层级 | 适用场景 | 需要完成 |
| --- | --- | --- |
| 仅安装 Skill | 让智能体认识能力、流程和安全边界 | 把完整 Skill 目录安装到目标智能体并重启会话 |
| 完整能力部署 | 真实加入飞书会议、持续监听并回传纪要 | 安装 Skill，配置 Bun、lark-cli、宿主运行能力、飞书应用权限和身份 |

Skill 不包含账号、Token、App Secret 或租户授权。复制目录不会自动获得外部系统权限。

## 2. 环境准备

通用依赖：

- Git：下载和升级仓库。
- Python 3：使用 Codex 内置 Skill Installer 时需要。
- Bun：运行 Skill 自带的 TypeScript helper。
- lark-cli：调用飞书开放能力。
- 支持 Skill 的智能体宿主：Codex、Claude Code、Gemini CLI，或其他能读取 `SKILL.md` 的运行时。

### 2.1 macOS

```bash
brew install git python
curl -fsSL https://bun.com/install | bash
exec "$SHELL"
git --version
python3 --version
bun --version
```

### 2.2 Windows

在 PowerShell 中执行：

```powershell
winget install --id Git.Git -e
winget install --id Python.Python.3.12 -e
powershell -c "irm bun.sh/install.ps1 | iex"
```

关闭并重新打开 PowerShell，然后检查：

```powershell
git --version
py --version
bun --version
```

### 2.3 Linux

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

生产环境建议使用专用非 root 账号运行智能体，不要把凭据写入仓库、配置样例或 Shell 历史。

## 3. 安装 Skill

### 3.1 Codex Skill Installer

macOS / Linux：

```bash
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
python3 "$CODEX_ROOT/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo yousay123/Agent-Skill-Hub \
  --ref feishu-meeting-attendee-v1.1.3 \
  --path skills/feishu-meeting-attendee
```

Windows PowerShell：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
py "$CodexRoot\skills\.system\skill-installer\scripts\install-skill-from-github.py" `
  --repo yousay123/Agent-Skill-Hub `
  --ref feishu-meeting-attendee-v1.1.3 `
  --path skills/feishu-meeting-attendee
```

### 3.2 Git 复制到 Codex

macOS / Linux：

```bash
git clone --depth 1 --branch feishu-meeting-attendee-v1.1.3 https://github.com/yousay123/Agent-Skill-Hub.git
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R Agent-Skill-Hub/skills/feishu-meeting-attendee \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Windows PowerShell：

```powershell
git clone --depth 1 --branch feishu-meeting-attendee-v1.1.3 https://github.com/yousay123/Agent-Skill-Hub.git
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$SkillsRoot = Join-Path $CodexRoot "skills"
New-Item -ItemType Directory -Force -Path $SkillsRoot | Out-Null
Copy-Item ".\Agent-Skill-Hub\skills\feishu-meeting-attendee" -Destination $SkillsRoot -Recurse -Force
```

### 3.3 Claude Code

将完整 Skill 目录放入用户级 `~/.claude/skills/`：

```bash
git clone --depth 1 --branch feishu-meeting-attendee-v1.1.3 https://github.com/yousay123/Agent-Skill-Hub.git
mkdir -p "$HOME/.claude/skills"
cp -R Agent-Skill-Hub/skills/feishu-meeting-attendee "$HOME/.claude/skills/"
```

Windows PowerShell：

```powershell
git clone --depth 1 --branch feishu-meeting-attendee-v1.1.3 https://github.com/yousay123/Agent-Skill-Hub.git
$SkillsRoot = Join-Path $HOME ".claude\skills"
New-Item -ItemType Directory -Force -Path $SkillsRoot | Out-Null
Copy-Item ".\Agent-Skill-Hub\skills\feishu-meeting-attendee" -Destination $SkillsRoot -Recurse -Force
```

### 3.4 Gemini CLI

优先使用原生安装命令：

```bash
gemini skills install https://github.com/yousay123/Agent-Skill-Hub.git \
  --path skills/feishu-meeting-attendee --scope user
```

也可以复制到 `~/.gemini/skills/`：

```bash
git clone --depth 1 --branch feishu-meeting-attendee-v1.1.3 https://github.com/yousay123/Agent-Skill-Hub.git
mkdir -p "$HOME/.gemini/skills"
cp -R Agent-Skill-Hub/skills/feishu-meeting-attendee "$HOME/.gemini/skills/"
```

Windows PowerShell：

```powershell
git clone --depth 1 --branch feishu-meeting-attendee-v1.1.3 https://github.com/yousay123/Agent-Skill-Hub.git
$SkillsRoot = Join-Path $HOME ".gemini\skills"
New-Item -ItemType Directory -Force -Path $SkillsRoot | Out-Null
Copy-Item ".\Agent-Skill-Hub\skills\feishu-meeting-attendee" -Destination $SkillsRoot -Recurse -Force
```

### 3.5 其他兼容宿主

复制整个 `skills/feishu-meeting-attendee` 目录，不能只复制 `SKILL.md`。宿主至少应：

1. 发现并完整读取 `SKILL.md`，按需读取其 `references/`。
2. 能用 Bun 执行 `scripts/` 下的 helper。
3. 能保持一个轮询进程或会话运行到会议结束。
4. 需要定时参会时，能在指定时间触发一次 Skill 执行。
5. 能把最终纪要恰好一次交付给发起会话。
6. 能安全保存飞书应用凭据和经过验证的用户身份映射。

如果宿主缺少定时能力，仍可在会议开始时手动触发；如果缺少持久会话能力，只能做单次事件读取，不能宣称已完整覆盖会议。

## 4. 配置 lark-cli 与飞书应用

按 [lark-cli Agent Skills 指引](https://github.com/larksuite/cli#agent-skills) 安装并为目标飞书应用建立独立配置。不同应用的凭据和身份映射必须隔离。

完成后检查：

```bash
lark-cli --version
lark-cli doctor
```

不要在仓库中提交 App Secret、Access Token、Cookie、用户邮箱或真实会议内容。`ou_...` open_id 是应用隔离身份，不能跨应用复制。

## 5. 飞书权限

### 5.1 核心权限

| 能力 | 权限 Scope | 何时需要 |
| --- | --- | --- |
| 应用机器人加入或离开会议 | `vc:meeting.bot.join:write` | 必需 |
| 读取会中事件和转写 | `vc:meeting.meetingevent:read` | 必需 |
| 发送入会介绍或经授权的会中消息 | `vc:meeting.message:write` | proxy / assistant 模式 |
| 私聊升级或通过 IM 回传结果 | `im:message:send_as_bot` 或更宽的 `im:message` | 使用对应功能时 |
| 接收智能体主人的私聊回复 | `im:message.p2p_msg:readonly` | 启用私聊决策升级时 |
| 接收群聊 @ 消息 | `im:message.group_at_msg:readonly` | 从群聊触发时 |

添加权限后，需要发布新的应用版本、在目标租户安装该版本，并保存权限数据范围。VC Agent 的会议拥有者数据范围应与应用可用人员范围一致。

推荐事件订阅：

- `vc.bot.meeting_invited_v1`：被邀请后入会。
- `vc.bot.meeting_activity_v1`：会中活动监听。
- `vc.bot.meeting_ended_v1`：会议结束的终态提示；从已落盘的本地归档收口，不依赖会后事件补读。
- `im.message.receive_v1`：接收 IM 指令和私聊决策回复。

按会议号和时间主动入会不依赖邀请事件。如果控制台里看不到 VC Scope/事件，或 API 返回 `ErrNotInGray` / `20017`，需要向飞书申请 VC Agent 能力，不能绕过租户授权。

### 5.2 可选权限

- 日历发现：`calendar:calendar:read`、`calendar:calendar.event:read`。用户直接提供会议号和开始时间时不需要。
- 通过企业邮箱或手机号解析人员：`contact:user.id:readonly`。
- 实时语音输出：`vc:meeting.bot.realtime:write`、会议侧“允许 AI 智能体发言”开关，以及独立实现的音频会话。当前 Skill 只发送文字。

## 6. 运行链路

```text
用户提供会议 ID/链接、时间与模式
  → 宿主校验输入、权限和已验证的智能体主人身份
  → 到会议时间触发 Skill（或立即执行）
  → join-and-greet.ts 入会并按模式发送一次介绍
  → poll-and-archive.ts 持续读取并可靠落盘会议事件
  → 宿主整理发言、决策、TODO、风险和采集限制
  → 必要且已启用时，私聊智能体主人做阻塞决策升级
  → 会议结束后从本地归档收口并报告尾部覆盖缺口
  → 通过宿主的标准交付接口发送一次纪要与任务草稿
```

Skill 自带的通用 helper：

```bash
bun scripts/join-and-greet.ts --help
bun scripts/poll-and-archive.ts --help
bun scripts/send-message.ts --help
```

## 7. 上线前冒烟测试

使用不含敏感信息的测试会议：

1. 先检查入会命令，不产生外部写入：

   ```bash
   bun scripts/join-and-greet.ts 123456789 --mode silent --dry-run
   ```

2. 开始测试会议，以 `silent` 模式真实入会，确认返回长格式 `meetingId`。
3. 单次读取会议事件：

   ```bash
   bun scripts/poll-and-archive.ts '<meetingId>' \
     --assigner-ref '<verified-assigner-open-id>' --max-polls 1
   ```

4. 测试 `proxy` 模式，确认介绍只发送一次。
5. 验证轮询会跨越短暂无发言继续运行，会议结束后从本地归档收口，并明确报告尾部覆盖缺口。
6. 如启用私聊决策升级，仅向已验证的智能体主人发送非约束性测试问题，并确认其他发送者的回复会被忽略。
7. 确认最终结果只回传一次，缺失的负责人或截止时间标为“待明确”。

外部写入结果不确定时停止自动重试，先检查会议或聊天记录。

## 8. 升级与停用

升级前先查看仓库变更和目标 Skill 的 release tag。只安装已通过 CI 与评审的固定 tag，再把完整 Skill 目录覆盖到目标位置；不要让生产环境自动跟随 `main`。重启智能体会话后重新运行冒烟测试。

需要暂时停用时，移动到备份目录，避免不可恢复删除：

macOS / Linux：

```bash
mv "$HOME/.claude/skills/feishu-meeting-attendee" \
  "$HOME/.claude/skills/feishu-meeting-attendee.disabled"
```

Windows PowerShell：

```powershell
Move-Item "$HOME\.claude\skills\feishu-meeting-attendee" `
  "$HOME\.claude\skills\feishu-meeting-attendee.disabled"
```

请按实际宿主目录替换示例路径。移动 Skill 不会撤销飞书权限或清除外部数据；这些需要在对应管理后台单独处理。

## 9. 常见问题

### 安装后智能体找不到 Skill

- 确认目录名是 `feishu-meeting-attendee`，入口文件是该目录根部的 `SKILL.md`。
- 确认 `scripts/`、`references/` 和 `assets/` 一并复制。
- 重启智能体会话，并检查宿主的 Skill 搜索路径。

### `bun` 或 `lark-cli` 找不到

- 用运行智能体的同一系统账号执行版本检查。
- 检查 PATH；服务进程的 PATH 可能与交互式终端不同。
- Windows 安装后重新打开 PowerShell。

### 能入会但读不到转写

- 检查 `vc:meeting.meetingevent:read`、应用版本和数据范围。
- 确认目标租户已安装最新应用版本。
- 确认会议和租户已开通 VC Agent 能力。

### 定时任务触发但没有完整纪要

- 确认宿主能保持轮询会话，不会在短暂无发言时回收进程。
- 检查持续归档是否运行到终态，以及 `final.json` 是否如实记录尾部覆盖缺口。
- 报告实际覆盖时间和断连，不要把部分记录描述成完整会议。

## 10. 上线检查清单

- [ ] 完整 Skill 目录已安装，宿主能发现 `SKILL.md`。
- [ ] Bun 和 lark-cli 在运行账号下可执行。
- [ ] 宿主能保持轮询进程，并在需要时按时触发。
- [ ] 飞书应用权限、版本和数据范围均已生效。
- [ ] VC Agent 能力已开通。
- [ ] 智能体主人身份在当前应用下验证，未跨应用复用 open_id。
- [ ] 三种模式和幂等消息在测试会议中通过。
- [ ] 私聊升级默认关闭，开启时只联系已验证身份。
- [ ] 纪要、TODO、风险、采集限制和待确认项格式符合预期。
- [ ] 仓库和日志中没有密钥或真实会议内容。

## 11. 官方参考

- [OpenAI Codex Skills](https://developers.openai.com/codex/skills/)
- [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills)
- [Gemini CLI Skills](https://geminicli.com/docs/cli/skills/)
- [Bun 安装](https://bun.com/docs/installation)
- [lark-cli Agent Skills](https://github.com/larksuite/cli#agent-skills)
