#!/usr/bin/env node
/**
 * 把 `overlay/brand/` 下的矢量素材渲染成位图（PNG），供需要图片格式的场合使用
 * （仓库首页、工作台市场投稿、聊天工具预览等）。
 *
 * 为什么保留两份：
 *   - `.svg` 是**权威源文件**（手写、可 diff、任意缩放不糊），由本脚本渲染出位图；
 *   - `.png` 是渲染产物，方便不支持 SVG 的场合。两者同名同目录，
 *     构建时由 `scripts/canvas-overlay.mjs` 一起拷进内嵌应用。
 *
 * 用法：
 *   node scripts/render-brand.mjs              # 默认 2 倍分辨率
 *   node scripts/render-brand.mjs --scale 3    # 3 倍
 *   node scripts/render-brand.mjs --check      # 只检查是否都需要重新渲染（不写文件）
 *
 * 渲染器用 @resvg/resvg-js（Rust 实现，无需浏览器）；中文字形依赖系统字体，
 * 所以这里显式把常见中文字体族放在首位。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brandRoot = join(root, 'overlay', 'brand')
const BRAND_DIRS = ['logo', 'product_showcase']

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const scale = Number(arg('--scale', 2))
const checkOnly = process.argv.includes('--check')
if (!Number.isFinite(scale) || scale <= 0) {
  console.error(`[brand] --scale 必须是正数，收到 ${arg('--scale', '')}`)
  process.exit(1)
}

let Resvg
try {
  ;({ Resvg } = await import('@resvg/resvg-js'))
} catch (error) {
  console.error('[brand] 缺少渲染器 @resvg/resvg-js。')
  console.error('        安装：npm install --save-dev @resvg/resvg-js')
  console.error(`        原始错误：${(error && error.message) || error}`)
  process.exit(1)
}

let rendered = 0
let upToDate = 0
const stale = []

for (const directory of BRAND_DIRS) {
  const absolute = join(brandRoot, directory)
  if (!existsSync(absolute)) {
    console.error(`[brand] 缺少素材目录：${absolute}`)
    process.exit(1)
  }
  for (const name of readdirSync(absolute).filter((file) => file.endsWith('.svg')).sort()) {
    const source = join(absolute, name)
    const target = source.replace(/\.svg$/, '.png')
    const relative = `${directory}/${name}`
    const fresh = existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs
    if (fresh) {
      upToDate += 1
      continue
    }
    if (checkOnly) {
      stale.push(relative)
      continue
    }
    const resvg = new Resvg(readFileSync(source, 'utf8'), {
      fitTo: { mode: 'zoom', value: scale }
      // ⚠ 不要在这里传 `font` 选项：实测 resvg-js 2.6.2 一旦给了 `font`，
      // `fitTo` 就会被忽略（zoom 2 依旧输出 1 倍图）。系统字体默认已加载
      // （loadSystemFonts 默认 true），SVG 里的 font-family 列表会按序匹配到
      // 「Microsoft YaHei」，中文字形正常。
    })
    const pixmap = resvg.render()
    const png = pixmap.asPng()
    writeFileSync(target, png)
    rendered += 1
    console.log(`[brand] ${relative} → ${name.replace(/\.svg$/, '.png')}  ${pixmap.width}×${pixmap.height}  ${(png.length / 1024).toFixed(1)} KB`)
  }
}

if (checkOnly) {
  if (stale.length) {
    console.error(`[brand] 以下位图缺失或早于矢量源文件，请运行 npm run brand:render：${stale.join('、')}`)
    process.exit(1)
  }
  console.log(`[brand] 位图都已就绪（${upToDate} 个）`)
} else {
  console.log(`[brand] 完成：新渲染 ${rendered} 个，已最新 ${upToDate} 个（缩放 ${scale}x）`)
}
