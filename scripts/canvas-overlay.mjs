#!/usr/bin/env node
/**
 * 把本包的画布定制（`overlay/`）施加到内嵌白板项目（drawnix）的源码，并按需重新构建。
 *
 * 为什么要有这个脚本：
 *   内嵌的白板是**第三方项目**（drawnix，MIT）。本工作台对它的改动只有
 *   「数据从哪来」这一件事，改动落在 `apps/web/src/app/app.tsx`（应用外壳）
 *   与构建配置两处。为了不把定制散落在别人的仓库里、也为了以后能一条命令重建，
 *   权威副本放在本包的 `overlay/`，由本脚本覆盖到白板源码。
 *
 * 用法：
 *   node scripts/canvas-overlay.mjs              只施加定制（不构建）
 *   node scripts/canvas-overlay.mjs --build      施加定制并构建（npm run build:web）
 *   node scripts/canvas-overlay.mjs --restore    用 git 还原白板源码（撤销定制）
 *   node scripts/canvas-overlay.mjs --source <drawnix 目录>   指定白板源码目录
 *
 * 注意：本脚本会写入**内嵌的白板项目目录**（源码是构建输入，绕不开）。除这两处
 * 文件外不碰任何白板项目文件；`--restore` 可一键还原。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceFlagIndex = process.argv.indexOf('--source')
const source = resolve(
  sourceFlagIndex !== -1 && process.argv[sourceFlagIndex + 1]
    ? process.argv[sourceFlagIndex + 1]
    : join(root, '..', 'drawnix')
)
const shouldBuild = process.argv.includes('--build')
const shouldRestore = process.argv.includes('--restore')

// overlay 文件 → 白板项目目标路径（相对白板源码仓库根）
const MAPPINGS = [
  { from: join(root, 'overlay', 'app.tsx'), to: join(source, 'apps', 'web', 'src', 'app', 'app.tsx') },
  { from: join(root, 'overlay', 'vite.config.ts'), to: join(source, 'apps', 'web', 'vite.config.ts') },
  { from: join(root, 'overlay', 'index.html'), to: join(source, 'apps', 'web', 'index.html') }
]

// 品牌素材：白板项目 public/ 下的 logo 与产品展示图是它自己的品牌，本包一律换成自己的设计。
// 白板项目 public/ 里的这些文件会被整目录清掉（源文件可随时用 --restore 从 git 还原）。
const PUBLIC_DIR = join(source, 'apps', 'web', 'public')
const BRAND_DIRS = ['logo', 'product_showcase']
// 位于 public 根目录下的单文件素材（应用图标）。
const BRAND_FILES = [
  { from: join(root, 'overlay', 'brand', 'favicon', 'favicon.ico'), to: join(source, 'apps', 'web', 'public', 'favicon.ico') }
]

// ---------------------------------------------------------------- 源码文案补丁 --
// 白板项目界面里写着它自己的品牌名与仓库链接（「更多」菜单的 GitHub、引导页标题、
// Mermaid/Markdown 转换对话框标题等）。本包对外的身份是「DSH 画板」+ 本仓库，所以改写这些字符串。
//
// ⚠ 两条硬规则（都踩过）：
//   1. **只改字符串值，绝不碰标识符**：语言包里的键名也叫 `mermaidToDrawnix`，
//      组件用 `t('extraTools.mermaidToDrawnix')` 取值，改了键名文案会整体消失；
//   2. 每条替换都要求**恰好命中一次**，命中数不符就中断——白板项目改了文案时这里必须报错，
//      而不是静默失效（否则界面悄悄变回白板原品牌，且没人会发现）。
const REPO_URL = 'https://github.com/andoaidlaksldk/DSHDrawWorkbench'
const TRANSLATIONS = 'packages/drawnix/src/i18n/translations'
const SOURCE_PATCHES = [
  {
    file: 'packages/drawnix/src/components/toolbar/app-toolbar/app-menu-items.tsx',
    note: '「更多」菜单里的 GitHub 链接',
    replacements: [[`href="https://github.com/plait-board/drawnix"`, `href="${REPO_URL}"`]],
    guard: [/plait-board\/drawnix/]
  },
  {
    file: 'packages/drawnix/src/data/json.ts',
    note: '打开/保存文件对话框的描述文案',
    replacements: [
      ["description: 'Drawnix files',", "description: 'DSH 画板文件',"],
      ["description: 'Drawnix file',", "description: 'DSH 画板文件',"]
    ],
    guard: [/'Drawnix file/]
  },
  {
    file: 'packages/drawnix/src/utils/image.ts',
    note: '导出图片的文件名前缀',
    replacements: [
      ['`drawnix-${new Date().getTime()}.svg`', '`dsh-board-${new Date().getTime()}.svg`'],
      ['`drawnix-${new Date().getTime()}.${ext}`', '`dsh-board-${new Date().getTime()}.${ext}`']
    ],
    guard: [/drawnix-\$\{/]
  },
  {
    file: `${TRANSLATIONS}/zh.ts`,
    note: '中文文案里的白板原品牌名与数据位置',
    replacements: [
      ["'dialog.mermaid.title': 'Mermaid 转 Drawnix'", "'dialog.mermaid.title': 'Mermaid 转画板'"],
      ["'。其他类型在 Drawnix 中将以图片呈现。'", "'。其他类型将以图片呈现。'"],
      ["'extraTools.mermaidToDrawnix': 'Mermaid 到 Drawnix'", "'extraTools.mermaidToDrawnix': 'Mermaid 到画板'"],
      ["'extraTools.markdownToDrawnix': 'Markdown 到 Drawnix'", "'extraTools.markdownToDrawnix': 'Markdown 到画板'"],
      ["'tutorial.title': 'Drawnix'", "'tutorial.title': 'DSH 画板'"],
      ["'tutorial.dataDescription': '所有数据被存在你的浏览器本地'", "'tutorial.dataDescription': '所有数据保存在 DSH 数据目录'"]
    ]
  },
  {
    file: `${TRANSLATIONS}/en.ts`,
    note: '英文文案里的白板原品牌名与数据位置',
    replacements: [
      ["'dialog.mermaid.title': 'Mermaid to Drawnix'", "'dialog.mermaid.title': 'Mermaid to board'"],
      ["'extraTools.mermaidToDrawnix': 'Mermaid to Drawnix'", "'extraTools.mermaidToDrawnix': 'Mermaid to board'"],
      ["'extraTools.markdownToDrawnix': 'Markdown to Drawnix'", "'extraTools.markdownToDrawnix': 'Markdown to board'"],
      ["'tutorial.title': 'Drawnix'", "'tutorial.title': 'DSH Draw Workbench'"],
      ["'tutorial.dataDescription': 'All data is stored locally in your browser'", "'tutorial.dataDescription': 'All data is stored in the DSH data directory'"]
    ]
  },
  {
    file: `${TRANSLATIONS}/ru.ts`,
    note: '俄文文案里的白板原品牌名与数据位置',
    replacements: [
      ["'dialog.mermaid.title': 'Mermaid в Drawnix'", "'dialog.mermaid.title': 'Mermaid в доску'"],
      ["'extraTools.mermaidToDrawnix': 'Mermaid в Drawnix'", "'extraTools.mermaidToDrawnix': 'Mermaid в доску'"],
      ["'extraTools.markdownToDrawnix': 'Markdown в Drawnix'", "'extraTools.markdownToDrawnix': 'Markdown в доску'"],
      ["'tutorial.title': 'Drawnix'", "'tutorial.title': 'DSH Draw Workbench'"],
      ["'tutorial.dataDescription': 'Все данные хранятся локально в вашем браузере'", "'tutorial.dataDescription': 'Все данные сохраняются в каталоге данных DSH'"]
    ]
  },
  {
    file: `${TRANSLATIONS}/vi.ts`,
    note: '越南文文案里的白板原品牌名与数据位置',
    replacements: [
      ["'dialog.mermaid.title': 'Mermaid sang Drawnix'", "'dialog.mermaid.title': 'Mermaid sang bảng'"],
      ["'extraTools.mermaidToDrawnix': 'Mermaid sang Drawnix'", "'extraTools.mermaidToDrawnix': 'Mermaid sang bảng'"],
      ["'extraTools.markdownToDrawnix': 'Markdown sang Drawnix'", "'extraTools.markdownToDrawnix': 'Markdown sang bảng'"],
      ["'tutorial.title': 'DPIT Draw MindMap'", "'tutorial.title': 'DSH Draw Workbench'"],
      ["'tutorial.dataDescription': 'Tất cả dữ liệu được lưu trữ cục bộ trong trình duyệt của bạn'", "'tutorial.dataDescription': 'Tất cả dữ liệu được lưu trong thư mục dữ liệu DSH'"]
    ]
  },
  {
    file: `${TRANSLATIONS}/ar.ts`,
    note: '阿拉伯文文案里的白板原品牌名与数据位置',
    replacements: [
      ["'dialog.mermaid.title': 'من Mermaid إلى Drawnix'", "'dialog.mermaid.title': 'من Mermaid إلى اللوحة'"],
      ["'extraTools.mermaidToDrawnix': 'من Mermaid إلى Drawnix'", "'extraTools.mermaidToDrawnix': 'من Mermaid إلى اللوحة'"],
      ["'extraTools.markdownToDrawnix': 'من Markdown إلى Drawnix'", "'extraTools.markdownToDrawnix': 'من Markdown إلى اللوحة'"],
      ["'tutorial.title': 'Drawnix'", "'tutorial.title': 'DSH Draw Workbench'"],
      ["'tutorial.dataDescription': 'تُحفظ جميع البيانات محليًا في متصفحك'", "'tutorial.dataDescription': 'تُحفظ جميع البيانات في مجلد بيانات DSH'"]
    ]
  }
]

// 补丁后不许再出现「值里带白板原品牌」的字符串（键名里的 brand 是标识符，必须保留）。
const BRAND_IN_VALUE = /:\s*'[^']*(?:Drawnix|DPIT)[^']*'/

function applySourcePatches() {
  const applied = []
  for (const patch of SOURCE_PATCHES) {
    const file = join(source, patch.file)
    if (!existsSync(file)) fail(`待打补丁的源文件不存在：${patch.file}（白板源码目录是否正确？）`)
    let text = readFileSync(file, 'utf8')
    let touched = 0
    let skipped = 0
    for (const [from, to] of patch.replacements) {
      const hits = text.split(from).length - 1
      // 幂等：本脚本常常连续跑（改完文案直接再构建一次），此时源文件里已经是新文案。
      if (hits === 0 && text.includes(to)) {
        skipped += 1
        continue
      }
      if (hits !== 1) {
        fail(`${patch.file} 里「${from}」命中 ${hits} 次（期望恰好 1 次）：白板源码文案已变动，请更新 canvas-overlay.mjs 的补丁表`)
      }
      text = text.replace(from, to)
      touched += 1
    }
    // 守恒检查每次运行都做（包括"已经是最新"的那次），否则品牌残留会在跳过路径上漏过去。
    for (const pattern of patch.guard || []) {
      if (pattern.test(text)) fail(`${patch.file} 仍匹配 ${pattern}（品牌没清干净）`)
    }
    if (patch.file.startsWith(TRANSLATIONS)) {
      const leak = BRAND_IN_VALUE.exec(text)
      if (leak) fail(`${patch.file} 里仍有带白板原品牌的值：${leak[0]}`)
    }
    const relative = patch.file.slice(source.length + 1).replace(/\\/g, '/')
    if (touched === 0) {
      applied.push(`${relative}（已是最新，跳过 ${skipped} 处）`)
      continue
    }
    writeFileSync(file, text, 'utf8')
    applied.push(`${relative}（${touched} 处${patch.note ? '：' + patch.note : ''}）`)
  }
  return applied
}

const DIST = join(source, 'dist', 'apps', 'web')
// 构建产物里必须出现这个标记：它只存在于我们的 overlay（app.tsx 的 API 前缀），
// 用来证明这次构建确实编译进了定制，而不是拿旧产物糊弄。
const BUILD_MARKER = 'dsh-draw-workbench'

function fail(message) {
  console.error(`[overlay] ${message}`)
  process.exit(1)
}

function countFiles(directory) {
  let total = 0
  const stack = [directory]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(current, entry.name))
      else total += 1
    }
  }
  return total
}

if (!existsSync(join(source, 'apps', 'web'))) {
  fail(`找不到内嵌的白板项目：${source}（可用 --source <drawnix 目录> 指定）`)
}

if (shouldRestore) {
  const targets = [
    ...MAPPINGS.map((mapping) => mapping.to.slice(source.length + 1).replace(/\\/g, '/')),
    ...BRAND_DIRS.map((name) => `apps/web/public/${name}`),
    ...BRAND_FILES.map((file) => file.to.slice(source.length + 1).replace(/\\/g, '/')),
    ...SOURCE_PATCHES.map((patch) => patch.file)
  ]
  const result = spawnSync('git', ['checkout', '--', ...targets], { cwd: source, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) fail('git 还原失败：请在白板源码仓库里手动检查。')
  console.log(`[overlay] 已还原白板源码与素材：${targets.join('、')}`)
  process.exit(0)
}

for (const { from, to } of MAPPINGS) {
  if (!existsSync(from)) fail(`缺少 overlay 文件：${from}`)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  console.log(`[overlay] ${to.slice(source.length + 1).replace(/\\/g, '/')} ← overlay/${from.slice(join(root, 'overlay').length + 1).replace(/\\/g, '/')}`)
}

// 品牌素材：整目录替换（先清空再拷贝，保证不会留下白板项目的同名文件）。
for (const name of BRAND_DIRS) {
  const from = join(root, 'overlay', 'brand', name)
  const to = join(PUBLIC_DIR, name)
  if (!existsSync(from)) fail(`缺少品牌素材目录：${from}`)
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    copyFileSync(join(from, entry.name), join(to, entry.name))
    console.log(`[overlay] public/${name}/${entry.name} ← overlay/brand/${name}/${entry.name}`)
  }
}

// public 根目录下的单文件素材（应用图标）。白板项目同名文件会被覆盖。
for (const { from, to } of BRAND_FILES) {
  if (!existsSync(from)) fail(`缺少品牌素材文件：${from}（运行 npm run brand:render 生成）`)
  copyFileSync(from, to)
  console.log(`[overlay] ${to.slice(source.length + 1).replace(/\\/g, '/')} ← overlay/brand/favicon/${from.split(/[\\/]/).pop()}`)
}

// 界面文案里的白板原品牌名与仓库链接：逐条严格替换（命中数不符即中断）。
for (const line of applySourcePatches()) console.log(`[overlay] 已改写 ${line}`)

// 施加后立刻做一次静态校验：overlay 必须真的落到目标文件里，
// 否则后面的构建会"成功"，但用的是旧逻辑。
const appShell = readFileSync(join(source, 'apps', 'web', 'src', 'app', 'app.tsx'), 'utf8')
// 注意：overlay 里接口路径是 `${API}/session` 这种拼接，所以只能断言 API 前缀本身。
for (const marker of ['/api/dsh-draw-workbench', 'session/data', 'postMessage']) {
  if (!appShell.includes(marker)) fail(`overlay 施加后 app.tsx 里没有找到标记「${marker}」`)
}
const viteConfig = readFileSync(join(source, 'apps', 'web', 'vite.config.ts'), 'utf8')
if (!/base:\s*'\.\/'/.test(viteConfig)) fail('vite.config.ts 里没有找到相对 base（base: \'./\'）')
console.log('[overlay] 定制已施加，静态校验通过')

if (!shouldBuild) {
  console.log('[overlay] 未指定 --build，跳过构建。构建请执行：node scripts/canvas-overlay.mjs --build')
  process.exit(0)
}

console.log('[overlay] 开始构建内嵌白板（nx build web → vite），通常 30-60 秒…')
// 必须跳过 nx 缓存：`public/` 下的素材（品牌 logo 与展示图）不在 nx 的构建输入指纹里，
// 只改素材时它会直接复用旧产物，结果是产物里缺文件、而构建"成功"（踩过一次：PNG 素材没进包）。
const build = spawnSync('npm', ['run', 'build:web', '--', '--skip-nx-cache'], {
  cwd: source,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
if (build.status !== 0) fail('内嵌白板的构建失败：请看上面的错误输出。')

if (!existsSync(join(DIST, 'index.html'))) fail(`构建完成但找不到产物入口：${join(DIST, 'index.html')}`)

// 构建闸门：产物里必须真的有定制标记，防止"构建成功但内容是旧的"。
let hits = 0
const stack = [DIST]
while (stack.length) {
  const current = stack.pop()
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) {
      stack.push(absolute)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    if (readFileSync(absolute, 'utf8').includes(BUILD_MARKER)) hits += 1
  }
}
if (hits === 0) fail(`构建产物里没有找到定制标记「${BUILD_MARKER}」：overlay 没有生效，请检查白板源码是否被还原。`)
console.log(`[overlay] 构建完成：${countFiles(DIST)} 个文件，${hits} 个产物含定制标记`)
console.log('[overlay] 下一步：node scripts/sync-app.mjs（把产物同步进本包的 app/）')
