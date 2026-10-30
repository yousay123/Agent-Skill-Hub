# Agent Skill Hub

面向 AI 智能体的可复用 Skill 集中站。仓库以统一目录规范管理可发现、可安装、可验证的智能体能力；每个 Skill 都是独立单元，入口文件为 `SKILL.md`，并可按需携带脚本、参考规则和输出素材。

## 项目目标

- 让 Codex、Claude Code、Gemini CLI 等支持 Skill 目录的智能体复用同一套能力。
- 把运行步骤、权限边界、依赖和验证方式随 Skill 一起交付。
- 通过机器可读的 `catalog.json` 支持后续检索、安装器和管理平台接入。
- 避免把个人账号、租户身份、密钥或特定会议信息固化进公共 Skill。

## 工作方式

```text
发现 Skill → 安装到智能体目录 → 重启会话并触发 Skill
     ↓              ↓                    ↓
catalog.json     SKILL.md            scripts / references
```

安装 Skill 只会把能力说明和辅助文件放入智能体目录；外部系统账号、应用权限和运行依赖仍需按对应 Skill 的部署文档配置。

## 目录结构

```text
.
├── README.md
├── CONTRIBUTING.md
├── catalog.json
├── docs/
│   └── INSTALL.md
└── skills/
    └── <skill-name>/
        ├── SKILL.md
        ├── scripts/       # 可选：可重复执行的辅助程序
        ├── references/    # 可选：按需读取的详细规则
        ├── assets/        # 可选：输出素材
        └── agents/        # 可选：特定 Agent 的 UI 元数据
```

## 已收录

| Skill | 说明 | 运行依赖 |
| --- | --- | --- |
| [feishu-meeting-attendee](skills/feishu-meeting-attendee/) | 飞书会议自动参会、会中监听、受控决策升级、中文纪要与 TODO 草稿 | lark-cli、Bun、可持续运行脚本的智能体宿主、飞书 VC Agent 权限 |

机器可读索引见 [catalog.json](catalog.json)。

## 快速开始

安装到 Codex 时，macOS 或 Linux 可执行：

```bash
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
python3 "$CODEX_ROOT/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo yousay123/Agent-Skill-Hub \
  --path skills/feishu-meeting-attendee
```

Windows PowerShell 可执行：

```powershell
$CodexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
py "$CodexRoot\skills\.system\skill-installer\scripts\install-skill-from-github.py" `
  --repo yousay123/Agent-Skill-Hub `
  --path skills/feishu-meeting-attendee
```

安装后重新打开智能体会话，再用自然语言提出参会请求。首次部署还需要配置飞书应用、运行依赖和权限。

Gemini CLI 可使用原生 Skill 安装命令：

```bash
gemini skills install https://github.com/yousay123/Agent-Skill-Hub.git \
  --path skills/feishu-meeting-attendee --scope user
```

Claude Code 或其他支持 `SKILL.md` 的智能体，可把完整 Skill 目录复制到对应的用户级 Skills 目录；不同运行时的路径和跨平台命令见完整手册。

完整说明见 [安装与部署手册](docs/INSTALL.md)，其中包含：

- macOS、Windows、Linux 的环境准备和具体命令；
- Codex、Claude Code、Gemini CLI 的安装目录；
- 安装验证、升级、卸载与故障排查；
- `feishu-meeting-attendee` 的飞书权限和上线检查清单。

## 安全边界

- 不跨飞书应用复用 `ou_...` open_id；它是应用隔离的身份。
- 不在仓库中保存 App Secret、Access Token、Cookie、个人邮箱或真实会议内容。
- 安装 Skill 不等于获得外部系统权限，也不扩大原智能体的授权范围。
- 对外部写操作、审批、费用、生产变更和敏感数据继续执行原有确认流程。

## 贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。新增 Skill 应保持独立、可发现、可验证，并在 `catalog.json` 登记。
