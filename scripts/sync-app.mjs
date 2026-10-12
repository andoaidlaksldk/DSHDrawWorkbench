#!/usr/bin/env node
/**
 * 把内嵌白板项目（drawnix）的构建产物同步进本包的内嵌应用目录 `app/`。
 *
 * 输入：<repo>/../drawnix/dist/apps/web（由 scripts/canvas-overlay.mjs --build 生成）
 * 输出：<repo>/app/**（静态资源）与 <repo>/app/index.html（宿主页）
 *
 * 做四件事：
 *   1. 拷贝产物，去掉与前端的托管方式无关的部署文件（_headers / _redirects / robots / sitemap）；
 *   2. 生成宿主页：白板项目入口页里的统计脚本与 SEO 元信息不进内嵌画布，标题用工作台的名字；
 *      （真正的 head 定制在 overlay/index.html，这里是产物层的兜底与校验）
 *   3. 文件名 ASCII 化：Harness 的精确 fetch 路由要求每一段匹配 `[A-Za-z0-9_$.-]`，
 *      非法文件名会让整个插件登记失败，因此改名并同步改写引用；
 *   4. 语法闸门：产物是 ESM，用 `node --check` 逐个真解析，不通过就中断。
 *
 * 用法：node scripts/sync-app.mjs [--source <drawnix 目录>]
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceFlagIndex = process.argv.indexOf('--source')
const source = resolve(
  sourceFlagIndex !== -1 && process.argv[sourceFlagIndex + 1]
    ? process.argv[sourceFlagIndex + 1]
    : join(root, '..', 'drawnix')
)
const sourceDist = join(source, 'dist', 'apps', 'web')
const appRoot = join(root, 'app')

function fail(message) {
  console.error(`[sync-app] ${message}`)
  process.exit(1)
}

if (!existsSync(join(sourceDist, 'index.html'))) {
  fail(`找不到内嵌白板的构建产物：${sourceDist}\n  请先执行：node scripts/canvas-overlay.mjs --build`)
}

// --- 1. 拷贝产物 --------------------------------------------------------------
// 先清空 app/（里面的每个文件都是内嵌白板的构建产物，没有需要保留的东西）。
for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
  rmSync(join(appRoot, entry.name), { recursive: true, force: true })
}
cpSync(sourceDist, appRoot, { recursive: true })

// 部署配置文件对内嵌托管没有意义：_headers/_redirects 是 Cloudflare Pages 的，
// robots/sitemap 是给搜索引擎的，留在包里只会增加噪声。
const DEPLOY_FILES = ['_headers', '_redirects', 'robots.txt', 'sitemap.xml']
for (const name of DEPLOY_FILES) {
  const target = join(appRoot, name)
  if (existsSync(target)) {
    rmSync(target, { force: true })
    console.log(`[sync-app] 已移除部署文件 app/${name}`)
  }
}

// --- 2. 宿主页 ---------------------------------------------------------------
const indexPath = join(appRoot, 'index.html')
let html = readFileSync(indexPath, 'utf8')
const before = html

// 统计脚本：内嵌画布是本地工具，不该联网上报。
html = html.replace(/\s*<script[^>]+umami[^>]*>\s*<\/script>/gi, '')
// 绝对根的 base 会让 assets/ 解析到站点根目录，子路径托管下整页 404。
html = html.replace(/\s*<base\s+href="\/"\s*\/?>/g, '')
// 标题/语言：换成工作台自己的身份。
html = html.replace(/<title>[\s\S]*?<\/title>/i, '<title>DSH 画板</title>')
html = html.replace(/<html lang="[^"]*"/i, '<html lang="zh-CN"')
if (html !== before) writeFileSync(indexPath, html, 'utf8')

const relativeAssetRefs = (html.match(/(src|href)="\.\/assets\//g) || []).length
if (relativeAssetRefs === 0) {
  console.warn('[sync-app] 警告：宿主页里没有找到相对路径的资源引用，请确认 overlay/vite.config.ts 的 base 生效')
}
// 守卫前先剥掉 HTML 注释：overlay 的注释里就写着这两个待清理项的名字，
// 不剥掉的话守卫会被自己的说明文字触发（踩过一次）。
const markup = html.replace(/<!--[\s\S]*?-->/g, '')
if (/<script[^>]*umami/i.test(markup)) fail('宿主页里仍然存在第三方统计脚本，同步中止。')
if (/<base\s[^>]*href\s*=\s*"\/"/i.test(markup)) fail('宿主页里仍然存在绝对根 base，子路径托管会白屏，同步中止。')
console.log(`[sync-app] 宿主页已就绪：${relativeAssetRefs} 处相对资源引用，无统计脚本、无绝对 base`)

// --- 3. 文件名 ASCII 化 -------------------------------------------------------
const SEGMENT_OK = /^[A-Za-z0-9_$.-]+$/
const TEXT_EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.svg', '.mjs', '.txt'])
const renames = []

function sanitizeFileName(name) {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const cleaned = base.replace(/[^A-Za-z0-9_$.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return `${cleaned || 'asset'}${extension}`
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      walk(absolute)
      continue
    }
    if (SEGMENT_OK.test(entry.name)) continue
    const extension = extname(entry.name)
    const stem = entry.name.slice(0, entry.name.length - extension.length)
    let next = sanitizeFileName(entry.name)
    let suffix = 2
    while (existsSync(join(directory, next))) next = `${sanitizeFileName(stem)}-${suffix++}${extension}`
    renameSync(absolute, join(directory, next))
    renames.push({ directory, from: entry.name, to: next })
    console.log(`[sync-app] 重命名非法文件名：${entry.name} → ${next}`)
  }
}

function rewriteReferences(oldName, newName) {
  let touched = 0
  const stack = [appRoot]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(absolute)
        continue
      }
      if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      const text = readFileSync(absolute, 'utf8')
      if (!text.includes(oldName)) continue
      writeFileSync(absolute, text.split(oldName).join(newName), 'utf8')
      touched += 1
    }
  }
  return touched
}

walk(appRoot)
for (const { from, to } of renames) {
  const touched = rewriteReferences(from, to)
  if (touched === 0) console.warn(`[sync-app] 提示：${from} 改名后没有找到引用它的文本文件，可能是未使用的素材`)
}
if (!renames.length) console.log('[sync-app] 所有产物文件名均符合路由段要求，无需改名')

// --- 4. 语法闸门 --------------------------------------------------------------
// 文本级改写（改名、清理）一旦误伤代码，产物会变成语法错误，表现是整块画布白屏。
// 这里对每个 JS 产物做真实解析：产物是 ESM，所以拷成 .mjs 再 `node --check`。
function assertJavaScriptParses() {
  const targets = []
  const stack = [appRoot]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) stack.push(absolute)
      else if (entry.name.endsWith('.js')) targets.push(absolute)
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-draw-syntax-'))
  const failures = []
  try {
    for (const file of targets) {
      const copy = join(scratch, `${targets.indexOf(file)}.mjs`)
      writeFileSync(copy, readFileSync(file, 'utf8'), 'utf8')
      const result = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' })
      if (result.status !== 0) {
        const detail = String(result.stderr || '').split('\n').find((line) => line.includes('SyntaxError')) || '语法错误'
        failures.push(`${file.slice(root.length)}：${detail.trim()}`)
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (failures.length) {
    console.error('[sync-app] 语法闸门未通过，已中断：')
    for (const line of failures) console.error(`    ${line}`)
    process.exit(1)
  }
  console.log(`[sync-app] 语法闸门通过（${targets.length} 个 JS 产物）`)
}

assertJavaScriptParses()

// --- 汇总 --------------------------------------------------------------------
let files = 0
let bytes = 0
const stack = [appRoot]
while (stack.length) {
  const current = stack.pop()
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) stack.push(absolute)
    else {
      files += 1
      bytes += statSync(absolute).size
    }
  }
}
console.log(`[sync-app] 源目录：${sourceDist}`)
console.log(`[sync-app] 已同步 ${files} 个文件（${(bytes / 1024 / 1024).toFixed(2)} MiB）到 app/`)
