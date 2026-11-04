# WorkDay 平台能力

系统技能以标准、自包含的 Skill 包随 WorkDay 代码与安装包交付，由原生管理入口选择使用。它们保留平台私有身份，不写入用户组件表；插件区只列业务扩展。Skill、MCP、Plugin 页面的“创建 / 添加”和“导入”六个入口发起专用对话。

## 能力清单

| 能力 | 入口与规则 | 执行器 | 状态与授权 |
| --- | --- | --- | --- |
| 创建 / 导入 Skill | Skill 页；`src/main/skill/capability/` | `components.start`、`workday_component_read/propose`、`components.confirm` | 完整目录复制、版本化预览；用户确认后安装，脚本不自动执行 |
| 创建 / 导入 MCP | MCP 页；`src/main/mcp/capability/` | 相同提案链，原生 MCP 配置 | 安装后停用；连接、发现与具体调用授权分开 |
| 创建 / 导入 Plugin | Plugin 页；`src/main/plugin/capability/` | 相同提案链，完整包验证与安装事务 | 保留资源、检查依赖；原生页面管理启停和卸载 |
| 中文描述补充 | 创建 / 导入时；`src/main/platform/description-zh.md`、`src/main/platform/component-descriptions.ts` | 描述叠加和现有精确描述目录 | 保留原描述与已有中文；缺少中文时补充，显示优先中文、否则回退原文 |
| 项目上下文与文件修改提案 | 已关联的本地项目 / GitHub 本地目录 | `src/main/projects/project-reader.ts`、`src/main/projects/project-files.ts`、`src/main/projects/project-protocol.ts` | 项目内读取、版本与路径绑定，修改经过提案 |
| 待办提案 | 聊天选定的待办与日期 | `src/main/service.ts` 中任务草案执行器 | 校验所选 ID、版本和项目；原子提交 |
| 媒体生成 | 对话中的生成请求 | `src/main/media/image-generation.ts`、`src/main/media/image-backup.ts` | 保留生成任务、素材、结果和重试边界 |
| 业务 Skill 资源与脚本 | 显式选择业务 Skill | `src/main/skill/skill-runtime.ts` | 只读所选包；配置解释器后逐次批准脚本，受限运行 |
| 业务 MCP 调用 | 上下文选择及原生授权 | `src/main/mcp/mcp.ts`、`src/main/service.ts` | 校验服务版本、归属和作用域内的只读授权 |

后五项本来就是 WorkDay 原生功能，本轮只梳理职责，没有新增执行工具或扩展权限。

## 平台规则与业务组件的分界

系统技能的维护入口如下，每个目录都包含 `SKILL.md`、合法的 YAML `name` / `description`、包内格式参考与工具契约：

| 系统技能 | 代码库目录 | 入口 |
| --- | --- | --- |
| Skill Creator | `src/main/skill/capability/skill-creator/` | Skill 创建 |
| Skill Installer | `src/main/skill/capability/skill-installer/` | Skill 导入 |
| MCP Manager | `src/main/mcp/capability/mcp-manager/` | MCP 添加、导入 |
| Plugin Manager | `src/main/plugin/capability/plugin-manager/` | Plugin 创建、导入 |

项目内的技能包目录与 YAML `name` 使用上述简名；WorkDay 适配范围写在描述和工具契约中。内部能力 key 保留 `workday.components` 命名空间，例如 `workday.components.skill-creator`。

`src/main/platform/platform-capabilities.ts` 按 `kind + intent` 的静态映射读取标准包，复用既有安全 YAML 解析，校验名称与目录一致、描述与正文有效、Markdown 相对引用存在且不越出包。读取实际资源树并计算摘要，正文去掉 frontmatter 后注入管理对话；参考文件通过 `workday_component_read(source: builtin)` 按需读取。每次授权检查重新读取资源，入口或参考文件发生变化后，旧会话的摘要绑定失效。工具权限仍由原生执行器决定，技能元数据不授予权限。

这些包不继承数据库 `Skill` 实体，不写入 `skills` / `plugins` 表，不参与 @、上下文选择器或定时任务。新包的中文与格式规则写在自身资源内，不依赖虚拟挂入文件或 Codex 安装目录。`src/main/platform/description-zh.md` 仅保留既有历史副本识别和回滚兼容用途。`scripts/build/build-platform-capabilities.cjs` 只复制四个声明的标准包到对应 `dist/main/` 子目录，并要求标准入口存在；完整构建先清理旧 `dist/`。

创建和导入对话持久化 `conversation.componentMode` 作为界面描述，`context.skillRef` 为空。真正权限只存在于 `ComponentAuthoring.sessions`，绑定会话、generation、能力 key / version / digest。伪造模式、恢复备份、历史 UUID、同名自定义 Skill 都不能创建授权。只有明确的六个入口能新建活态会话。

管理对话提供读取已选材料与生成提案两个工具。安装需确认，连接、启停、卸载、发现与授权继续由原生操作完成。它不运行 Codex 安装器、不读取 Codex 配置、不调用 Codex 私有插件 API，不自动联网或授予权限。“结束管理”、停止、归档、版本变化等会使待确认提案失效；重启不恢复会话和材料 token。管理请求不可重试或续写，需重新从入口开始；普通聊天的停止、继续和重试保持原行为。

## 已复制平台组件的兼容

用户确认内置的三项为 `skill-creator`、`skill-installer`、`Plugin Management 0.1.0`。其有效职责现适配到独立 Creator、Installer 和 Plugin 管理包；MCP 管理包服务原有配置入口。Creator 保留范围澄清、技能编写、资源与自查、提案确认流程；Installer 保留选定完整材料、结构和资源检查、来源升级、中文补充及安装回执流程。WorkDay 工具面不提供原 Codex 安装器的远程目录或 GitHub 下载脚本，因此没有复制不可执行的网络流程，也不声称原包逐字移植。`src/main/platform/platform-copies.ts` 冻结旧来源摘要和资源树摘要，运行时完全不依赖 Codex 目录：

- 独立 Skill 同时匹配来源摘要、安装根 / 入口 / 归属、实际树与存储摘要，以及数据库正文和描述。creator 支持原版与先前精确的中文补丁版本。
- Plugin Management 同时匹配包 key / 版本 / 树、唯一 Skill 入口与归属，并要求没有附加 MCP 或其它组件。
- 同名自定义组件、改动后的正文或资源、不同来源或归属都保留为业务扩展。未匹配身份保留在分类诊断中，不按名称批量处理。

匹配项退出公开列表、普通选择和调用、启停 / 编辑 / 卸载入口。原数据库行、文件与历史消息保留，便于回滚；没有删除私人组件目录。涉及这些组件的旧计划暂停，旧聊天显示能力已内置提示，旧引用不会隐式转换成管理授权。分类在相关操作和执行边界重新校验，导入、升级、恢复与资源修改不会永久复用旧标签。相同已知来源再次导入时提示内置入口。

导出备份剔除已确认平台副本的行和包文件，并清理聊天、计划、消息快照中的相关引用。旧备份正常验证和恢复原行 / 文件；新副本启动时重新分类，账号、授权和运行期会话不恢复。原有三个管理 UUID 仅用于识别历史和拒绝伪造，不能再解析为 Skill。

## 验证与维护

`tests/platform/system-skills.test.ts` 验证四包标准入口、六模式路由、坏元数据与缺失/越界引用拒绝、完整资源摘要及真实资源修改导致会话失效。`tests/platform/platform-capabilities.test.ts` 使用冻结的非秘密源树在临时目录验证正例、修改 / 同名负例、原行保留、导出 / 恢复和失效模式。`tests/platform/component-chat.test.ts` 覆盖六入口实际指令注入、材料完整性、模型提案、确认与撤权。`scripts/smoke/internal-capabilities-smoke.cjs` 验证实际渲染交互；兼容 smoke 为 `scripts/smoke/component-chat-smoke.cjs`。所有测试均使用隔离数据和合成模型，不接触个人数据库或真实 MCP 服务。

增加平台能力应维护标准系统技能包、静态注册表和受限执行器，不能靠伪造用户 Skill 身份获取权限。新增业务能力使用用户组件系统；遇新的来源版本应先审查指纹与职责，再明确更新兼容清单。
