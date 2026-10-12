# 第三方声明

本项目是**二次开发**：以开源白板 [Drawnix](https://github.com/plait-board/drawnix) 为基础，
在其之上实现 DSH 桌面工作台。本项目自身的代码（`dsh/`、`lib/`、`scripts/`、`overlay/`）
以 MIT 许可发布，见 [`LICENSE`](LICENSE)。

## 1. 内嵌的白板应用（`app/` 目录）

`app/` 是白板应用的构建产物，来自 Drawnix：

| 项 | 值 |
|---|---|
| 项目地址 | <https://github.com/plait-board/drawnix> |
| 许可 | MIT（版权 `Copyright (c) 2024 Drawnix`） |
| 许可全文 | 与 MIT 标准条款相同，见本包 [`LICENSE`](LICENSE) |
| 构建方式 | 本仓库不含其源码；`scripts/canvas-overlay.mjs` 从本机的白板源码目录（默认 `../drawnix`）重新构建，再由 `scripts/sync-app.mjs` 同步进 `app/` |

对白板源码的改动只有三处，其余是素材与文案替换：

1. **应用外壳** `apps/web/src/app/app.tsx`：数据改由本工作台接口读写（原先存浏览器 IndexedDB），并接入多画板协议；
2. **构建配置** `apps/web/vite.config.ts`：改用相对 `base`（子路径托管必需）；
3. **宿主页** `apps/web/index.html`：去掉统计脚本与绝对根 `<base>`，标题改为本工作台名称。

此外由 `scripts/canvas-overlay.mjs` 的素材与文案补丁表统一处理：品牌 logo、产品展示图、
应用图标换成本项目设计，界面文案里的原品牌名与仓库链接换成本项目信息。
**绘图内核（图形、连线、思维导图、手绘、导入导出）未作任何修改**，`.drawnix` 数据格式保持兼容。

所有改动的权威副本在本仓库的 `overlay/` 与补丁表中；执行
`node scripts/canvas-overlay.mjs --restore` 可把白板源码还原为 Drawnix 原样。

## 2. 白板应用依赖的第三方库

`app/` 产物中包含 Drawnix 依赖的第三方库，均以 MIT 等宽松许可分发，主要包括：

| 包 | 许可 |
|---|---|
| `@plait/core`、`@plait/common`、`@plait/draw`、`@plait/mind`、`@plait/layouts` 等 | MIT（plait-board） |
| `react`、`react-dom` | MIT (Meta) |
| `slate`、`slate-react`、`slate-history` | MIT |
| `localforage`、`browser-fs-access`、`is-hotkey`、`classnames`、`mobile-detect`、`roughjs`、`laser-pen`、`ahooks` | MIT / Apache-2.0 |
| `@floating-ui/react` | MIT |
| `mermaid` 及其子依赖（流程图 / 时序图等渲染） | MIT |
| `@plait-board/markdown-to-drawnix`、`@plait-board/mermaid-to-drawnix` | MIT |

完整依赖树与版本见白板项目自身的 `package.json` 与 `package-lock.json`。

## 3. 出处标注

Drawnix 的名称、仓库地址与版权声明仅出现在本文档、仓库 README 与包元数据中，用于如实标注来源；
界面上不再保留其品牌元素。若需要与 Drawnix 原版逐项比对，可执行
`node scripts/canvas-overlay.mjs --restore` 还原源码后重新构建。
