# 定制 WorkDay 主题

主题配置入口是 [`src/renderer/theme.ts`](../src/renderer/theme.ts)。用户可在“设置 → 主题”选择黑白、蓝白、自定义；默认黑白。旧森林绿设置启动时迁移为黑白，并保留有效背景图片。

## 在设置中自定义

选择“自定义”后，可编辑工作台底色、面板色、正文色、次级文字色、强调色、边框色、事项卡片色。颜色接受六位 hex。字号比例范围 0.85–1.25、间距比例 0.75–1.25、圆角比例 0–1.5；默认均为 1。公共尺度同时作用于页面和 Mantine 控件/Portal。颜色标签、默认值、范围和 token 目标均在 `customThemeFields` 唯一定义。

编辑为草稿，点击“应用”保存后生效；“恢复默认”只恢复自定义变量并保留背景。切换到预设后仍保留已保存的自定义值。范围或格式不合法会提示错误，保留草稿与上次外观。不支持自由 CSS 或任意 JSON 输入。

背景行提供缩略图与上传/更换/移除操作，支持 PNG、JPEG、WebP；没有人为文件字节或像素数上限，不缩放、不压缩原图。上传会检查签名并真实解码；实际系统内存、浏览器磁盘配额或解码器可能失败，错误不会替换当前背景。

外观使用 renderer 同源 IndexedDB `workday-appearance` v1 的 `appearance` store，固定 `current` 记录存放 `{schemaVersion:1, theme, custom, background: Blob|null}`。配置与背景在同一事务提交后才更新显示。`workday.appearance` localStorage 仅用于旧数据迁移；提交成功后清理，后续优先使用 IndexedDB。迁移失败保留旧配置并显示旧背景。新配置不存 base64 或 object URL；临时和替换后的 object URL 都回收。外观尚未加载或保存期间禁用编辑，旧页面的上传解码结果不会跨页面覆盖新设置。

开发者修改配置后运行相关单测、`npm run typecheck` 和 `npm run build`，再验证独立 Electron fixture。

## 修改现有主题

- `themeConfig.themes`：主题名称、说明、`colorScheme` 和配色。设置页、偏好校验、Mantine 明暗模式都由这里派生。
- `themeDefaults`：所有主题的公共字体、字号、行高、字重、间距、圆角、边框、阴影、透明度、动画时长和公共组件尺寸。
- 单主题 `tokens`：只覆写需要变化的组与字段，其余继承 `themeDefaults`。每次切换重新解析完整配置，切换回来不会残留上一个主题的值。
- `preview`：默认由该主题的 app-surface、surface、border、mint 派生；自定义预览从已保存的公共变量解析；通常不需要独立设置。

例如在 `mono` 项中增加：

```ts
mono: {
  name: '黑白', description: '白色背景，黑灰文字', colorScheme: 'light',
  palette: { ...monoPalette, mint: '#5b55b9' },
  tokens: {
    fontSize: { md: '14px', sm: '13px' },
    radius: { md: '10px', panel: '16px' },
    size: { action: '36px', modal: '480px' },
    space: { 8: '10px' }
  }
}
```

`space` 的数字是尺度名，而不是自动计算表达式。比如 `space[8]` 默认是 8px，可改成 10px；零间距、auto 和布局比例不在此尺度内。`size.action` 控制图标按钮；待办操作列取 `size.taskActionSlot` 与按钮宽度的较大值，避免大按钮挤在原列宽内。

长度使用带单位的 CSS 字符串（常用 px/rem），字体用 CSS font-family 字符串；行高、字重和透明度可用无单位字符串。`mantineRadius` / `mantineSpace` 保留组件库原先的 rem 尺度，普通页面的 `radius` / `space` 保留原先的 px 尺度；二者独立命名是为了保持现有默认外观，定制时可一起调整。原 Mantine 数字尺寸（例如 Modal 的 460）实际会转成 rem，本配置保留其等效值 `28.75rem`，避免重构时改变现有大小；需要固定像素时可明确改成 px。不要把颜色或尺寸写回 TSX。

截止日期格的斜纹由 `palette.deadline-stripe`（半透明白色）和 `palette.deadline-underlay`（浅衬色）控制；`size.deadlineStripeWidth`、`size.deadlineStripePeriod` 分别控制线宽和重复间距。斜纹叠加在现有日期、周末、节假日和选中底色上，保留文字和边框。

月历待办圆圈与数量按当天未完成、未删除事项的最高优先级着色，复用 `palette.priority-p0-text`、`palette.priority-p1-text`、`palette.priority-p2-text`，与列表中的 P0/P1/P2 标签颜色一致。

日列表的会议和事项共用 `palette.day-card`、`palette.day-card-hover` 卡片底色，以及 `size.dayListRow` 最小高度、`radius.md` 圆角和 `space[8]` / `space[10]` 内距。编辑与删除在悬停或键盘聚焦时显示于卡片右上角，不占正文宽度；不支持悬停的设备始终显示操作。角标的点击尺寸、图标分别由 `size.taskCornerAction` / `iconSize.taskCornerAction` 控制，沿卡片上沿居中，右侧缩进 `space[6]`、按钮间距 `space[2]`；底色、圆角与阴影复用 `palette.surface` / `radius.small` / `shadow.navigation`。

会议时间独立显示为小标签，使用 `fontSize.tiny`、`fontWeight.medium`、`palette.surface`、`radius.small` 和 `space[3]` / `space[6]` 内距；完整时间与标题仍通过原提示显示，全天及跨天时间格式保持一致。

页面四边外边距与 Home 两栏间隔统一由 `space.workspaceGutter` 控制，默认 5px，窄窗口也使用同一值。Home 待办面板与输入区之间由 `space.homeColumnGap` 控制，默认 4px。项目页保留贴边布局的零外边距和零栏间距。

设置页复用公共页面宽度、内距和标题字号。模型目录使用自适应卡片网格，`size.settingsModelCardMin` 控制每列最小宽度、`size.settingsModelCardHeight` 控制卡片最小高度、`size.settingsModelList` 控制目录滚动区最大高度；卡片间隔为 `space[8]`，底色与圆角复用 `palette.surface-subtle` 和 `radius.md`。

设置与插件页共用 `.tabs` 圆角分段页签：`size.tab` 控制最小高度，`space[4]` 控制条内距与间隔，按钮内距为 `space[6]` / `space[12]`，圆角复用 `radius.control` / `radius.md`。条底色使用 `palette.surface-subtle`，选中项为 `palette.surface` 和 `palette.mint`，悬停使用 `palette.button-hover`；键盘焦点环绘于按钮内部，避免滚动容器裁切。不要再添加页面专属页签外观或独立 active 状态，保持 Mantine `data-active` 为唯一选中样式来源。

## 增加主题

在 `themeConfig.themes` 追加一个对象，提供 `name`、`description`、`colorScheme`、完整 `palette`（可展开已有 palette）与可选 `tokens` / `preview` 即可。主题 ID 类型、设置页选项和保存偏好校验自动更新，不需要另改主题 ID 枚举。若要设为启动默认主题，修改 `defaultTheme`；已有用户保存的主题仍优先。

## CSS 与组件库

`themeVariables(getTheme(id, custom))` 输出完整 CSS 自定义属性，`applyAppearance` 在首帧布局阶段写入 `document.documentElement`。这样 body 下的 Modal、Menu、Tooltip Portal 也能继承。配色沿用 `--text`、`--surface`、`--mint` 等语义名；尺度如 `--text-sm`、`--space-8`、`--radius-panel`、`--size-action`。

`component-theme.tsx` 只负责 Mantine 适配，公共尺寸和排版均引用同一组变量；图标通过 `--icon-*`，弹窗、菜单和按钮通过 `--size-*`。预览用 `previewVariables(id, custom)` 从相应主题取得颜色。背景图片走 Blob 签名/解码验证，并使用独立 `--background-image`；图片 CSP 仅额外允许 `img-src blob:`。

聊天、默认模型和定时任务共用 Mantine `Select` 模型选择器，按模型源分组，选项和已选值只显示模型名称。弹层宽度与列表最大高度由 `size.modelMenu` / `size.modelMenuMaxHeight` 控制，超长列表滚动；圆角、阴影和选中底色复用 `radius.card`、`shadow.notification`、`palette.surface-selected`。

`ui.tsx` 中的共享 `Dropdown` 和 `ModelPicker` 接受 `width`：`width={240}` 使用固定 240px，`width="fill"` 铺满可用区域（默认），`width="content"` 随当前选中文字或占位文字宽度收缩。聊天使用 `content`，设置和定时任务表单默认 `fill`。内容宽度用 Electron 支持的 CSS `field-sizing:content` 计算，跟随字体和主题变化，并受父容器限宽；长名称截断，不挤出发送按钮。触发器宽度与展开菜单宽度独立。

## 保留在 CSS / 素材中的部分

插件、知识库和定时任务的缺省插画使用 `assets/illustrations/empty-states/` 的透明 PNG；统一显示尺寸由 `themeDefaults.size.emptyArt` 控制，底部间距复用 `space.11`。同目录 `.prompt.txt` 保存内置 imagegen 的生成提示词。

`style.css` 保留选择器、布局（display/grid/flex）、定位关系、百分比、滚动及响应式结构。媒体查询和容器查询阈值仍是字面量，因为 CSS 自定义属性不能用于这些查询条件。日历格数、整体布局宽度、聊天跳转标记的几何、SVG 路径/viewBox、天气插画内部颜色与原始素材尺寸也保留原处。圆形的几何、透明背景和遮罩黑色不是独立主题配色。

定制较大的字体或间距仍需检查窄窗口的长标题、表格和弹窗。优先运行 `scripts/calendar-layout-smoke.cjs`、`scripts/public-components-smoke.cjs`、`scripts/custom-theme-smoke.cjs`（`appearance-smoke.cjs` 也会调用它；依赖 Playwright，使用隔离数据及本地天气/日历 fixture）。`scripts/theme-config-smoke.cjs` 保存与比较默认主题的 computed styles；定制用例验证真实页面和 Portal 对配置生成变量的响应。测试不能连接个人模型源或修改真实待办。
