# 贡献指南

## 新增 Skill

1. 在 `skills/<skill-name>/` 创建目录，名称只使用小写字母、数字和连字符。
2. 必须包含 `SKILL.md`，其 YAML frontmatter 至少包含 `name` 和 `description`。
3. `description` 说明“做什么、何时触发”，避免吸引无关请求。
4. 通用工作流和关键安全边界放在 `SKILL.md`；条件性细节放入 `references/`。
5. 只有重复执行或确定性逻辑需要时才加入 `scripts/`；脚本必须能独立验证。
6. 输出素材放入 `assets/`；不要把素材当作指令加载。
7. 在 `catalog.json` 增加机器可读条目，并更新 README 的已收录表。

## 安全与可移植性

- 禁止提交口令、Token、Cookie、私有密钥和内部系统地址。
- 禁止提交特定人员的邮箱、手机号、open_id 或个人别名；使用可配置占位符。
- 明确区分只读操作和写操作；不把安装 Skill 等同于获得外部系统授权。
- 外部身份必须在目标应用或目标租户内重新解析和验证。
- 对不确定写入结果停止自动重试，优先查重和人工确认。

## 推荐结构

```text
skills/<skill-name>/
├── SKILL.md
├── scripts/       # optional
├── references/    # optional
├── assets/        # optional
└── agents/        # optional
```

不要为占位而创建空目录。安装说明、依赖和权限应在 `SKILL.md` 或被其直接链接的 reference 中可发现。

## 提交前验证

- 校验 YAML frontmatter 和目录名一致。
- 搜索并移除个人身份、密钥和环境专属路径。
- 执行新增或修改的脚本的 `--help`、dry-run 或无副作用测试。
- 确认 `SKILL.md` 中引用的相对路径全部存在。
- 查看最终 diff，确保没有压缩包、缓存、日志或临时文件。
