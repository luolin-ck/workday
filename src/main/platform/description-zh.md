<!-- workday-description-zh:v1 -->
## WorkDay 中文描述

创建或更新 Skill 时，保留原 `description`，并检查 YAML `metadata.description_zh`。缺失或空白时，根据实际用途、触发条件和重要限制补一份完整中文描述；原文已是中文时可直接复制。原文仅含少量中文触发词不算完整中文描述。已有非空中文保持不变，除非用户明确要求修改。保留其他 metadata 和正文，不新增能力承诺。

若任务同时产出 Plugin，保留原描述，并按实际格式补中文：`workday-plugin.json` 的 `descriptionZh`、portable `plugin.json` 的 `extensions.workday.descriptionZh`，或 legacy `.codex-plugin/plugin.json` 的 `descriptionZh`。包内各 Skill 使用 `metadata.description_zh`。仅补充任务范围内的描述，不扩大为 MCP 配置或权限更改。

导入已有完整目录时保留脚本、参考资料、二进制资产和文件权限。若当前 WorkDay 管理对话提供 `workday_component_propose`，可用 `materialToken` 加 `descriptionsZh: [{path, descriptionZh}]` 补齐：path 为所选材料根下由解析器确认的主 manifest 或 Skill 入口相对路径；不覆盖已有非空中文，也不将整个目录重写成文本 `files`。不改源目录，继续由用户审阅提案并确认安装。新建 `files` 直接写入上述字段。未提供该工具时，在本次产出目录中按格式补齐，不假设工具可用。

交付前验证 frontmatter 与格式，确认原描述和资源仍在、中文用途准确；WorkDay 展示时优先使用非空中文，缺失时回退原描述。
