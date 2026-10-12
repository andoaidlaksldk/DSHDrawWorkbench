#!/usr/bin/env node
/**
 * 工作台包自检：把《工作台市场验收规范》里「自动检查」会看的项目在本地先跑一遍。
 *
 * 直接读取 `pnpm pack` 产出的 `.tgz`（纯 Node 解 gzip + 解析 tar，不依赖系统 tar）：
 *
 *   1. 安装契约：完整 SemVer、`repository` 指回 GitHub 仓库、`dsh.bundle.patch`、
 *      `dsh.client.inject` 含 `dsh-desktop-workbenches`、`exports["./client"]` 真实存在、
 *      新包不声明 `register({ id })`。
 *   2. 必需文件：服务端入口、客户端入口、`cordis.patch.yml`、README、LICENSE、内嵌应用入口。
 *   3. 体积上限 8 MiB。
 *   4. 不得包含可疑文件：`.env`、密钥、证书、数据库、以及与交付无关的杂散文件
 *      （`*.bak`、`*.tmp`、`*.orig`、`*.rej`、`*~` 等）。
 *   5. 不得包含本机绝对路径（`app/dist` 内的压缩代码只告警，其余一律失败）。
 *
 * 用法：node scripts/check-package.mjs [package.tgz]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tarball = resolve(process.argv[2] || join(root, `${manifest.name}-${manifest.version}.tgz`))

const MAX_TARBALL_BYTES = 8 * 1024 * 1024
const JUNK_NAME = /(^|\/)\.(env|npmrc|git)|\.(bak|tmp|orig|rej|swp|log|sqlite|db)$|~$|\.bak-|id_rsa|\.pem$|\.key$/i
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.yml', '.yaml', '.txt', '.svg', '.map'])
const ABSOLUTE_PATH_PATTERNS = [
  /[A-Za-z]:\\{1,2}[^\s"'`<>|*?]{2,}/,
  /(^|[^\w-])\/(?:Users|home)\/[A-Za-z0-9._-]+\//
]

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  \u2713 ${label}`)
}
function fail(label) {
  console.error(`  \u2717 ${label}`)
  process.exitCode = 1
}

/** 最小 tar 解析：只要文件名与内容，够本脚本用。 */
function readTarEntries(buffer) {
  const entries = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const readString = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '').trim()
    const name = readString(0, 100)
    const prefix = readString(345, 155)
    const sizeField = readString(124, 12)
    const size = sizeField ? parseInt(sizeField, 8) : 0
    const typeFlag = header.subarray(156, 157).toString('utf8')
    const path = prefix ? `${prefix}/${name}` : name
    const dataStart = offset + 512
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      entries.push({ path, data: buffer.subarray(dataStart, dataStart + size) })
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

if (!existsSync(tarball)) {
  console.error(`[check-package] 找不到 ${tarball}；先运行 pnpm pack。`)
  process.exit(1)
}

console.log(`[check-package] ${tarball}`)

const archive = readTarEntries(gunzipSync(readFileSync(tarball)))
const entries = archive.map((entry) => entry.path)
const relative = entries.map((path) => path.replace(/^package\//, ''))
const size = readFileSync(tarball).length

// ------------------------------------------------------------ 1. 安装契约 --

const packed = archive.find((entry) => entry.path === 'package/package.json')
if (!packed) {
  fail('tarball 内缺少 package.json')
} else {
  const packedManifest = JSON.parse(packed.data.toString('utf8'))
  if (packedManifest.name !== manifest.name) fail(`包名不一致：${packedManifest.name}`)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packedManifest.version || '')) fail(`version 不是完整 SemVer：${packedManifest.version}`)
  else if (packedManifest.version !== manifest.version) fail(`tarball 内版本 ${packedManifest.version} 与源 ${manifest.version} 不一致`)
  const repo = packedManifest.repository?.url || ''
  if (!repo) {
    console.log('  ! 尚未声明 repository：上架工作台市场前必须补上你自己的 GitHub 仓库地址')
  } else if (!/^git\+https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/.test(repo)) {
    fail(`repository 必须指回 GitHub 仓库，当前为 ${JSON.stringify(repo)}`)
  }
  if (packedManifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch 必须为 ./cordis.patch.yml')
  if (packedManifest.dsh?.client?.platform !== 'web') fail('dsh.client.platform 必须为 web')
  const inject = packedManifest.dsh?.client?.inject
  if (!Array.isArray(inject) || !inject.includes('dsh-desktop-workbenches')) fail('dsh.client.inject 必须包含 dsh-desktop-workbenches')
  if (packedManifest.exports?.['./client'] !== './lib/client.js') fail('exports["./client"] 必须指向真实存在的客户端入口')
  if (!relative.includes('lib/client.js')) fail('tarball 内缺少 exports["./client"] 指向的 lib/client.js')
  if (!relative.includes('cordis.patch.yml')) fail('tarball 内缺少 cordis.patch.yml')
  if (!relative.includes('dsh/index.js')) fail('tarball 内缺少服务端入口 dsh/index.js')
  ok(`安装契约完整（${packedManifest.name}@${packedManifest.version}${repo ? `，repository=${repo}` : ''}）`)
}

// 新包不得声明 register({ id })（市场以仓库 owner/repo 作为身份）
const clientSource = archive.find((entry) => entry.path === 'package/lib/client.js')
if (clientSource) {
  const text = clientSource.data.toString('utf8')
  if (/register\(\s*\{[^}]*\bid\s*:/.test(text)) fail('客户端 register() 不得声明 id（新包协议）')
  else ok('客户端 register() 未声明旧的 id 字段')
}

// ------------------------------------------------------------ 2. 必需文件 --

const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'dsh/index.js',
  'lib/client.js',
  'app/index.html',
  'README.md',
  'LICENSE'
]
const missing = REQUIRED.filter((path) => !relative.includes(path))
if (missing.length) fail(`缺少必需文件：${missing.join('、')}`)
else ok(`必需文件齐全（共 ${relative.length} 个条目）`)

// 内嵌画布的构建产物：入口页引用的 assets/*.js 必须真的进包，否则装上去是白屏。
const bundleEntries = relative.filter((path) => path.startsWith('app/assets/') && path.endsWith('.js'))
if (!bundleEntries.length) fail('包内缺少 app/assets/*.js（内嵌画布的构建产物）')
else ok(`内嵌画布产物已入包（${bundleEntries.length} 个构建脚本）`)

// --------------------------------------------------------------- 3. 体积 --

if (size > MAX_TARBALL_BYTES) fail(`包体积 ${(size / 1048576).toFixed(2)} MiB 超过 8 MiB 上限`)
else ok(`包体积 ${(size / 1048576).toFixed(2)} MiB（上限 8 MiB）`)

// --------------------------------------------------- 4. 可疑/杂散文件 --

const junk = relative.filter((path) => JUNK_NAME.test(path))
if (junk.length) fail(`包内不应包含杂散或敏感文件：${junk.join('、')}`)
else ok('未发现 .env / 密钥 / 证书 / 数据库 / 备份等可疑文件')

// ------------------------------------------- 5. 本机绝对路径与敏感串 --

// 内嵌白板的产物是上游压缩代码（`app/assets/` 下）：压缩后的正则字面量里带反斜杠转义
// （例如 mermaid 的 `/^(?:activate\\b)/i`），会被「盘符路径」模式误判。所以这一目录只告警、
// 不失败；本工作台自己的源码（dsh/、lib/、scripts/、overlay/）一旦出现本机路径就是硬失败。
const EMBEDDED_BUILD_PREFIX = 'app/assets/'
const offenders = []
const warnings = []
for (const entry of archive) {
  const path = entry.path.replace(/^package\//, '')
  if (path === 'package.json') continue
  if (!TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) continue
  if (entry.data.length > 2 * 1024 * 1024) continue
  if (/[\u0000-\u0008\u000e-\u001f]/.test(entry.data.subarray(0, 2048).toString('latin1'))) continue
  const text = entry.data.toString('utf8')
  const hit = ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(text))
  if (!hit) continue
  if (path.startsWith(EMBEDDED_BUILD_PREFIX)) warnings.push(path)
  else offenders.push(path)
}
if (offenders.length) fail(`包内含本机绝对路径：${offenders.join('、')}`)
else ok('包内未出现本机绝对路径（本工作台自有代码）')
if (warnings.length) console.log(`  ! ${EMBEDDED_BUILD_PREFIX} 下的上游压缩产物命中疑似路径模式（多为正则转义误报），建议人工确认：${warnings.join('、')}`)

if (process.exitCode) {
  console.error(`\n[check-package] 未通过（${checks} 项通过，见上方 ✗）`)
} else {
  console.log(`\n[check-package] 全部通过（${checks} 项）`)
}
