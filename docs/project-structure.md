# 工程结构

文件先按 Electron 进程边界划分，再按功能归类。修改一个功能时，从对应模块查找实现、资源和测试；不要为了把同名文件集中在一起而跨越主进程与渲染进程边界。

## 源码入口

| 目录 | 职责 |
| --- | --- |
| [`src/main/`](../src/main/) | Electron 主进程：系统能力、持久化、模型请求和受限执行器 |
| [`src/preload/`](../src/preload/) | 主进程与界面之间的桥接入口 |
| [`src/renderer/`](../src/renderer/) | React 页面、交互、主题及界面素材 |
| [`src/shared/`](../src/shared/) | 两个进程共用的类型、协议与日期规则 |
| [`native/`](../native/) | macOS Swift 辅助程序源码；构建时在这里生成可执行文件 |

`src/main/index.ts` 保留应用启动入口，`src/main/service.ts` 保留服务编排；`schemas.ts`、`validation.ts`、`network.ts` 保留跨模块校验和网络边界。`src/main/keychain-access.ts` 涉及路径身份校验，继续保留在原位置。`src/preload/index.ts`、`src/renderer/main.tsx` 和 `src/renderer/style.css` 也保持稳定入口。

## 功能归类

| 功能 | 主进程 | 界面与资源 |
| --- | --- | --- |
| Skill | [`src/main/skill/`](../src/main/skill/)：Skill 运行时，`capability/` 保存创建和导入规则 | [`src/renderer/skill/`](../src/renderer/skill/)：详情界面与 `assets/` |
| MCP | [`src/main/mcp/`](../src/main/mcp/)：连接与调用，`capability/` 保存创建和导入规则 | [`src/renderer/mcp/assets/`](../src/renderer/mcp/assets/)；MCP 页签仍由插件管理页面组织 |
| Plugin | [`src/main/plugin/`](../src/main/plugin/)：组件包解析、迁移与 `capability/` 规则；包解析也服务于 Skill 导入 | [`src/renderer/plugin/`](../src/renderer/plugin/)：三类组件的管理页面、Plugin 详情、试用与 `assets/` |
| 平台管理 | [`src/main/platform/`](../src/main/platform/)：三类组件共用的创作会话、私有能力注册、描述与副本识别 | [`src/renderer/shared/`](../src/renderer/shared/) 中的材料、预览及组件图标 |
| 对话 | [`src/main/chat/`](../src/main/chat/)：附件、协议、中断与消息统计 | [`src/renderer/chat/`](../src/renderer/chat/)：消息、输入、上下文选择与快捷命令 |
| 项目 | [`src/main/projects/`](../src/main/projects/)：GitHub、检出目录、项目读取和修改提案 | [`src/renderer/projects/`](../src/renderer/projects/)：项目页面和侧栏 |
| 日历与计划 | [`src/main/calendar/`](../src/main/calendar/)：节假日、会议、提醒及天气服务 | [`src/renderer/calendar/`](../src/renderer/calendar/)：日历、计划与每日提示；天气界面及素材在 [`src/renderer/weather/`](../src/renderer/weather/) |
| 媒体 | [`src/main/media/`](../src/main/media/)：生图和媒体备份 | 展示复用对话模块 |
| 存储 | [`src/main/storage/`](../src/main/storage/)：数据库、凭证存储及备份校验 | 设置页面在 [`src/renderer/settings/`](../src/renderer/settings/) |
| 知识库 | 主进程服务编排中处理 | [`src/renderer/knowledge/`](../src/renderer/knowledge/) |

通用界面组件、图标、主题和外观存储放在 `src/renderer/shared/`。Skill、MCP、Plugin 各自的 `assets/` 包含 `icon.png`、`empty.png` 和 `empty.prompt.txt`；其余公共空态图在 `assets/illustrations/empty-states/`，品牌资源在 `assets/branding/`。平台内置规则随构建交付，不作为用户插件展示；详见 [平台能力](platform-capabilities.md)。

## 脚本与测试

| 目录 | 用途 |
| --- | --- |
| [`scripts/build/`](../scripts/build/) | 编译原生辅助程序、复制平台规则等构建步骤 |
| [`scripts/release/`](../scripts/release/) | macOS 打包与构建归档 |
| [`scripts/fixtures/`](../scripts/fixtures/) | 隔离 Electron 启动器、模型及场景夹具；MCP 模拟服务在 `mcp/` |
| [`scripts/smoke/`](../scripts/smoke/) | 功能烟测；Skill、Plugin 专项在各自子目录 |
| [`scripts/browser/`](../scripts/browser/) | 浏览器验收入口；Plugin 专项在 `plugin/` |
| [`scripts/tools/`](../scripts/tools/) | 示例数据、组件迁移准备和天气检查工具 |
| [`tests/`](../tests/) | 按 `skill/`、`plugin/`、`platform/`、`chat/`、`projects/`、`calendar/`、`weather/`、`appearance/`、`core/`、`tooling/` 分类 |
| [`tests/fixtures/`](../tests/fixtures/) | 跨测试共用的非秘密夹具，保持统一位置 |

从项目根目录运行常用命令：

```sh
npm run typecheck
npm test -- tests/skill/skill-runtime.test.ts
npm run build
npm run smoke
```

`npm run build` 先清理 `dist/`，再构建原生程序、主进程、规则资源和界面。测试文件中的目录定位、脚本入口和打包资源路径应与模块迁移同步更新。Electron 验收使用独立 `WORKDAY_DATA_DIR` 和 `scripts/fixtures/electron-fixture-launch.cjs`，不能使用个人数据。打包、安装及回滚约定见 [AGENTS.md](../AGENTS.md)。

## 派生产物与文档

- `dist/`：构建产物，主进程规则保留与源码对应的功能目录；不要手工修改。
- `release/`：应用包与回滚归档；调整源码目录不会自动更新正式应用。
- `test-data/`：本地隔离验证数据；`test-results/`：验证日志；`output/playwright/`：界面截图和烟测结果。
- `docs/`：维护中的工程说明；`docs/iterations/`：按实际时间记录的迭代历史，旧记录中的路径保留历史含义。

目录归类不改变运行期用户数据位置，也不移动或清理个人文件、安装组件和凭证。新增文件按实际职责放入现有模块；多模块共用代码才进入公共目录，避免重新堆回根目录。
