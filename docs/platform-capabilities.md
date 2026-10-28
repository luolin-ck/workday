# WorkDay 平台能力

平台管理规则随 WorkDay 代码与安装包交付，不是可安装、启停或选择的用户 Skill。插件区只列业务扩展；平台管理仍由 Skill、MCP、Plugin 页面的“创建 / 添加”和“导入”六个入口发起专用对话。

## 能力清单

| 能力 | 入口与规则 | 执行器 | 状态与授权 |
| --- | --- | --- | --- |
| 创建 / 导入 Skill | Skill 页；`src/main/platform-capabilities/skill/` | `components.start`、`workday_component_read/propose`、`components.confirm` | 完整目录复制、版本化预览；用户确认后安装，脚本不自动执行 |
| 创建 / 导入 MCP | MCP 页；`src/main/platform-capabilities/mcp/` | 相同提案链，原生 MCP 配置 | 安装后停用；连接、发现与具体调用授权分开 |
| 创建 / 导入 Plugin | Plugin 页；`src/main/platform-capabilities/plugin/` | 相同提案链，完整包验证与安装事务 | 保留资源、检查依赖；原生页面管理启停和卸载 |
| 中文描述补充 | 创建 / 导入时；`platform-capabilities/description-zh.md`、`component-descriptions.ts` | 描述叠加和现有精确描述目录 | 保留原描述与已有中文；缺少中文时补充，显示优先中文、否则回退原文 |
| 项目上下文与文件修改提案 | 已关联的本地项目 / GitHub 本地目录 | `project-reader.ts`、`project-files.ts`、`project-protocol.ts` | 项目内读取、版本与路径绑定，修改经过提案 |
| 待办提案 | 聊天选定的待办与日期 | `service.ts` 中任务草案执行器 | 校验所选 ID、版本和项目；原子提交 |
| 媒体生成 | 对话中的生成请求 | `image-generation.ts`、`image-backup.ts` | 保留生成任务、素材、结果和重试边界 |
| 业务 Skill 资源与脚本 | 显式选择业务 Skill | `skill-runtime.ts` | 只读所选包；配置解释器后逐次批准脚本，受限运行 |
| 业务 MCP 调用 | 上下文选择及原生授权 | `mcp.ts`、`service.ts` | 校验服务版本、归属和作用域内的只读授权 |

后五项本来就是 WorkDay 原生功能，本轮只梳理职责，没有新增执行工具或扩展权限。

## 平台规则与业务组件的分界

`platform-capabilities.ts` 定义私有能力 key、版本、指令、参考文件和摘要。它不继承 `Skill`，不写入 `skills` / `plugins` 表，不参与 @、上下文选择器或定时任务。资源由 `scripts/build-platform-capabilities.cjs` 清洁复制；构建同时清除旧 `dist/main/builtin-skills`。

创建和导入对话持久化 `conversation.componentMode` 作为界面描述，`context.skillRef` 为空。真正权限只存在于 `ComponentAuthoring.sessions`，绑定会话、generation、能力 key / version / digest。伪造模式、恢复备份、历史 UUID、同名自定义 Skill 都不能创建授权。只有明确的六个入口能新建活态会话。

管理对话提供读取已选材料与生成提案两个工具。安装需确认，连接、启停、卸载、发现与授权继续由原生操作完成。它不运行 Codex 安装器、不读取 Codex 配置、不调用 Codex 私有插件 API，不自动联网或授予权限。“结束管理”、停止、归档、版本变化等会使待确认提案失效；重启不恢复会话和材料 token。管理请求不可重试或续写，需重新从入口开始；普通聊天的停止、继续和重试保持原行为。

## 已复制平台组件的兼容

用户确认内置的三项为 `skill-creator`、`skill-installer`、`Plugin Management 0.1.0`。其职责已分别合并到 Skill 创建、完整目录导入和 Plugin 管理规则。`platform-copies.ts` 冻结来源摘要和资源树摘要，运行时完全不依赖 Codex 目录：

- 独立 Skill 同时匹配来源摘要、安装根 / 入口 / 归属、实际树与存储摘要，以及数据库正文和描述。creator 支持原版与先前精确的中文补丁版本。
- Plugin Management 同时匹配包 key / 版本 / 树、唯一 Skill 入口与归属，并要求没有附加 MCP 或其它组件。
- 同名自定义组件、改动后的正文或资源、不同来源或归属都保留为业务扩展。未匹配身份保留在分类诊断中，不按名称批量处理。

匹配项退出公开列表、普通选择和调用、启停 / 编辑 / 卸载入口。原数据库行、文件与历史消息保留，便于回滚；没有删除私人组件目录。涉及这些组件的旧计划暂停，旧聊天显示能力已内置提示，旧引用不会隐式转换成管理授权。分类在相关操作和执行边界重新校验，导入、升级、恢复与资源修改不会永久复用旧标签。相同已知来源再次导入时提示内置入口。

导出备份剔除已确认平台副本的行和包文件，并清理聊天、计划、消息快照中的相关引用。旧备份正常验证和恢复原行 / 文件；新副本启动时重新分类，账号、授权和运行期会话不恢复。原有三个管理 UUID 仅用于识别历史和拒绝伪造，不能再解析为 Skill。

## 验证与维护

`tests/platform-capabilities.test.ts` 使用冻结的非秘密源树在临时目录验证正例、修改 / 同名负例、原行保留、导出 / 恢复和失效模式。`tests/component-chat.test.ts` 覆盖六入口、材料完整性、模型提案、确认与撤权。`scripts/internal-capabilities-smoke.cjs` 验证实际渲染交互；兼容 smoke 为 `scripts/component-chat-smoke.cjs`。所有测试均使用隔离数据和合成模型，不接触个人数据库或真实 MCP 服务。

增加平台能力应扩展私有注册表和受限执行器，不能再次制造“隐藏 Skill”。新增业务能力使用用户组件系统；遇新的来源版本应先审查指纹与职责，再明确更新兼容清单。
