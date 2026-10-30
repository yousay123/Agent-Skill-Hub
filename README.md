# Agent Skill Hub

面向 AI 智能体的可复用 Skill 集中站。每个 Skill 都是一个独立目录，入口文件为 `SKILL.md`，可按需携带 `scripts/`、`references/`、`assets/` 和 `agents/`。

## 目录结构

```text
.
├── README.md
├── CONTRIBUTING.md
├── catalog.json
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
| [feishu-meeting-attendee](skills/feishu-meeting-attendee/) | 飞书会议自动参会、会中监听、受控决策升级、中文纪要与 TODO 草稿 | Botmux、lark-cli、Bun、飞书 VC Agent 权限 |

机器可读索引见 [catalog.json](catalog.json)。

## 安装

### 安装单个 Skill

```bash
python3 "$CODEX_HOME/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo yousay123/Agent-Skill-Hub \
  --path skills/feishu-meeting-attendee
```

也可以把完整目录复制到目标 Agent 的 Skill 目录，例如：

- Codex：`~/.codex/skills/`
- Claude Code：`~/.claude/skills/`
- Gemini CLI：`~/.gemini/skills/`
- 项目级共享：`<project>/skills/`

安装后重新打开会话，让 Agent 重新发现 Skill。

## 使用前检查

- 阅读目标 Skill 的 `SKILL.md` 和它链接的相关 reference。
- 配置该 Skill 声明的 CLI、应用权限和用户身份。
- 不跨飞书应用复用 `ou_...` open_id；它是应用隔离的身份。
- 对外部写操作、审批、费用、生产变更和敏感数据保持原有授权边界。

## 贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。新增 Skill 应保持独立、可发现、可验证，并在 `catalog.json` 登记。
