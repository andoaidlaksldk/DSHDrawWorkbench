# 第三方声明

本工作台自身（`dsh/`、`lib/`、`scripts/`、`overlay/`）以 MIT 许可发布，见 `LICENSE`。
下面列出随包分发的第三方内容及其许可。

## 1. 内嵌白板应用（`app/` 目录）

`app/` 是本工作台内嵌的白板应用构建产物，源自开源项目 **Drawnix**：

- 项目地址：<https://github.com/plait-board/drawnix>
- 许可：**MIT**
- 版权：`Copyright (c) 2024 Drawnix`
- 获取方式：本仓库不包含其源码，构建脚本从本机上游目录（默认 `../drawnix`）重新构建后同步进 `app/`。

对上游源码的改动**只有一处业务文件**（应用外壳 `apps/web/src/app/app.tsx`）、构建配置
（`apps/web/vite.config.ts`，加相对 base）与宿主页（`apps/web/index.html`，去掉统计脚本与
绝对 base）。改动以 `overlay/` 为权威副本，由 `scripts/canvas-overlay.mjs` 施加，
`--restore` 可一键还原。**白板本身的绘图能力（图形、连线、思维导图、手绘、导入导出）
未作任何修改。**

## 2. 内嵌白板所依赖的框架

`app/` 产物中包含 Drawnix 依赖的第三方库，均以 MIT 许可分发，主要包括：

| 包 | 许可 |
|---|---|
| `@plait/core`、`@plait/common`、`@plait/draw`、`@plait/mind`、`@plait/layouts` 等 | MIT（plait-board） |
| `react`、`react-dom` | MIT (Meta) |
| `slate`、`slate-react`、`slate-history` | MIT |
| `localforage`、`browser-fs-access`、`is-hotkey`、`classnames`、`mobile-detect`、`roughjs`、`laser-pen`、`ahooks` | MIT / Apache-2.0 |
| `@floating-ui/react` | MIT |
| `mermaid` 及其子依赖（流程图/时序图等渲染） | MIT |
| `@plait-board/markdown-to-drawnix`、`@plait-board/mermaid-to-drawnix` | MIT |

完整依赖树与版本见内嵌产物对应的上游项目 `package.json` 与 `package-lock.json`。

## 3. 上游品牌保留说明

与「尽量只呈现本工作台身份」的处理方式不同，**内嵌白板界面仍保留其上游项目名称与图标**
（登录页标题、工具栏 logo、关于对话框等）。这是有意为之：本包尚未对上游 UI 做品牌清理，
以保证行为与上游完全一致、便于比对上游版本。本仓库的文档、包描述与工作台注册信息中，
本工作台一律自称「DSH 画板」，不使用上游项目名作为产品名。

如后续需要与思维导图工作台一致地清理界面品牌，可在 `scripts/sync-app.mjs` 中增加
产物文案替换工序（务必只替换字符串字面量，并保留既有的产物语法闸门）。
