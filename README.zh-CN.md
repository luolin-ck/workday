# WorkDay

**开发中：第一版尚未完成。** 本仓库公开持续开发中的源码，目前没有正式 Release 或安装包，接口、数据格式和行为仍可能调整。

[English](README.md) | 简体中文

WorkDay 是一款本地桌面工作台，将月历、待办、AI 对话与项目上下文放在一起。使用 Electron、React、TypeScript 和基于 sql.js 的 SQLite 构建，目前界面主要为中文。

## 正在开发的功能

- **月历与待办：** 按日管理待办、备注、截止日期、完成与撤销，显示农历、节气、节日和城市天气；节日名称与官方休假、调休安排分别展示。
- **AI 对话：** 对接兼容 Chat Completions 的模型源，支持流式回复、附件、所选聊天上下文、待办草案和聊天归档。
- **项目上下文：** 关联本地文件夹和 GitHub 仓库，按范围浏览、读取与搜索文件；单文件文本新建或修改提案须由用户明确确认，应用不会自动 commit 或 push。
- **知识与扩展：** 显式选择 Markdown / 文本知识资料、指令型 Skill、已授权的 MCP 工具与资源，以及本地声明式 Plugin 包。
- **运行时计划：** 支持一次、每日、每周和每两周执行，固定所选模型、上下文与工具权限。
- **本地数据：** 使用 SQLite 持久化，支持排除凭证及工具授权的校验备份副本，并提供主题与背景图片设置。

这些能力仍在迭代，源码中已经存在的功能不代表第一版已经完成全面验收。

## 开发环境

- **macOS：** 当前构建会编译文件访问、附件、图像转换及钥匙串访问所需的 Swift helper，暂不支持完整的 Windows 或 Linux 构建。
- **Xcode Command Line Tools：** 需要可用的 `xcrun`、macOS SDK、Swift 编译器和 `codesign`。尚未安装时可运行 `xcode-select --install`。
- **Node.js 22.12 或更新版本**，建议 Node.js 24，并使用 npm。
- 首次安装依赖需要联网；使用真实 AI 服务时，需要自行提供兼容的接口及必要凭证。

## 从源码启动

```sh
git clone https://github.com/luolin-ck/workday.git
cd workday
npm ci --legacy-peer-deps --registry=https://registry.npmjs.org --cache=.npm-cache
npm run build
WORKDAY_DATA_DIR="$PWD/test-data/development" npm start
```

最后一条命令使用隔离的开发数据目录。如需使用默认应用数据目录，可去掉 `WORKDAY_DATA_DIR`，直接运行 `npm start`。修改源码后需要重新构建。

### 使用本地模拟模型

在另一个终端运行：

```sh
npm run mock
```

在 WorkDay 的 **设置 → 模型源** 中手工添加：

| 字段 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:4319/v1` |
| 模型 ID | `workday-mock` |
| API Key | 留空 |
| Tools | 明确勾选支持 |

这是显式启动的本地模拟服务，不是真实 AI 模型；按 Ctrl+C 停止。使用真实模型时，填写兼容 Chat Completions 的 Base URL、模型 ID 及必要的 API Key。优先使用 HTTPS：HTTP 会明文传输凭证和对话内容。每个模型的 tools 能力都须明确选择。

### 生成 Plugin 示例

```sh
node scripts/create-example.cjs
```

命令会生成 `examples/summary-plugin`，包含摘要 Skill 与本地模拟 MCP 连接。生成配置会写入当前 Node 程序和工程路径，因此不提交到 Git；移动工程后需要重新生成。在 Plugin 页面导入生成的文件夹，MCP 仍保持停用，只有明确启用、发现并授权后才可使用。

## 验证

```sh
npm run typecheck
npm test
npm run build
```

测试使用合成夹具；部分集成测试需要监听本机回环地址，原生 helper 测试还需要 macOS 开发工具。测试和应用数据、生成的构建及验证输出均不提交到 Git。

七项历史平台副本检查依赖可选的本机第三方夹具；该夹具在确认再分发许可前不纳入仓库，因此全新克隆会明确跳过这七项。独立的平台权限测试仍会运行，详见[夹具覆盖说明](tests/fixtures/platform-copies/README.md)。当前开发基线还存在损坏历史提交和缺失主题 CSS 变量的已知失败检查，`npm test` 尚未全部通过。

可选桌面烟测使用 Playwright 的 Electron API：

```sh
npm run smoke
```

需要开发环境已有可用的 Playwright 模块，也可通过 `WORKDAY_PLAYWRIGHT_MODULE` 指向其模块路径。烟测使用 `test-data/` 下的隔离数据，结果写入 `output/playwright/`；其中还会检查公开的政府节假日服务，因此需要联网。执行此命令属于开发验证，不代表完整产品验收。

## 数据与服务边界

- 默认数据保存在 Electron 的 WorkDay userData 目录，macOS 通常为 `~/Library/Application Support/WorkDay`。启动时使用 `WORKDAY_DATA_DIR` 可选择独立开发目录或恢复出的备份副本。
- 模型及 GitHub 凭证与业务数据分离，通过 Electron safeStorage 和 macOS 钥匙串集成使用系统安全存储；安全存储不可用时拒绝保存凭证。业务备份不包含凭证和授权。
- 本地存储不意味着 AI 请求也在本地执行。实际使用时，所选消息、附件、知识和项目内容会发送给配置的模型源，请核对所选数据及可信服务。
- 项目文本修改须明确点击 **应用到文件夹**。文件过滤与大小限制可减少暴露，但不能代替完整的秘密检测。
- MCP 发现不等于授权，需要为聊天或计划明确授权具体工具与资源。必须信任服务器的真实行为；“只读”描述不能证明它没有外部副作用。
- 天气通过 ipwho.is 近似定位网络出口，通过 Open-Meteo 搜索城市和查询天气；相关服务会接收到网络地址或城市坐标。中国官方休假、调休安排从政府来源查询。
- 定时计划只在应用运行且电脑唤醒时执行。退出或休眠期间错过的时间点会被记录，不会自动补跑；退出后没有常驻服务。
- 恢复备份会建立独立副本，不覆盖原数据库。恢复后的模型源与 MCP 停用，授权清空，计划暂停。

## 当前限制

第一版尚未完成，不保证兼容任意第三方模型接口或 MCP 服务。目前界面及月历习惯主要面向中文使用场景，部分原生日历集成还依赖本机 macOS 日历配置。

当前没有云同步、账号体系、在线 Plugin 市场、任意 Plugin 脚本执行，也不会无人确认地提交或推送项目代码。本地 Plugin 采用声明式配置。长对话、附件和备份存在大小限制；sql.js 持久化面向个人本地使用规模。

包中的 `0.1.0` 是开发元数据，不代表已宣布发版。本仓库不提供正式签名、公证的安装包，也不承诺已达到生产使用标准。

## 源码结构与贡献

| 路径 | 用途 |
| --- | --- |
| `src/main/` | Electron 服务、持久化、模型请求、项目访问和扩展 |
| `src/preload/` | 渲染器桥接 |
| `src/renderer/` | React 界面、主题与交互 |
| `src/shared/` | 共享类型、协议与日期规则 |
| `native/` | macOS Swift helper 源码 |
| `tests/` 与 `scripts/` | 测试、夹具、构建与验证工具 |

参与开发前请阅读[开发约定](AGENTS.md)，实现细节可参考[主题定制](docs/theming.md)和[平台能力说明](docs/platform-capabilities.md)。提交中不要包含凭证、个人数据、生成产物或本机验证输出。欢迎修复和文档改进，项目仍在推进第一版。

## 开源协议

WorkDay 原创源码采用 [MIT License](LICENSE)，版权归属为 © 2026 luolin-ck。第三方组件继续遵循各自协议，其中 Lucide / Feather 图标的许可声明保留在 [public/lucide-LICENSE.txt](public/lucide-LICENSE.txt)。
