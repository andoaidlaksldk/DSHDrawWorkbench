/**
 * 把本包安装进本机 DSH Desktop（官方 Desktop profile 由应用的**进程内插件管理器**托管）。
 *
 * 为什么这么做：DSH Desktop 的插件安装不是「把文件拷进去」，而是管理器围绕
 * **一个代际目录**维护 7 处相互印证的记录。任何一处对不上，管理器会在下次启动时
 * 对账并把它清掉（本包就被这样清过一次，原因是它记录的来源 tgz 被删了）。
 *
 * 逐条对应（路径以 <harness>=%APPDATA%\dsh-desktop\harness 为根）：
 *   1. profiles/web/package.json            → dependencies[<名>] = <版本>
 *   2. profiles/web/package.json            → dsh.profile.bundles 含 <名>
 *   3. profiles/web/package.json            → dsh.desktop.generationProjection.plugins[<名>]
 *   4. profiles/web/package.json            → pnpm.overrides[<名>] = link:../.generations/live/<代际>/node_modules/<名>
 *   5. profiles/.generations/live/<代际>/    → 物化出的包（含 generation.json / package.json）
 *   6. profiles/.generations/desired.json   → 含 <代际>
 *   7. profiles/web/node_modules/<名>        → 指向第 5 项的 Junction
 *
 * 代际 ID 形如 `<名>+<版本>+<12位十六进制>`。观察日志可知它**不是内容指纹**
 * （同一个 1.0.0 的 tgz 两次安装得到两个不同哈希），只是唯一标识，所以这里可以自建。
 *
 * 关键前提：第 5 项 package.json 里记录的 `file:` tgz **必须一直存在**。
 * 删掉它，管理器下次启动就无法按记录重新物化，会把插件清掉。
 *
 * 用法：
 *   node scripts/install-to-desktop.mjs --dry-run
 *   node scripts/install-to-desktop.mjs
 *   node scripts/install-to-desktop.mjs --harness "<harness 目录>"
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-draw-workbench'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_ENTRIES = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']
const PACKAGE_DIRS = ['dsh', 'lib', 'app']

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const harnessIndex = args.indexOf('--harness')
const harnessHome = harnessIndex !== -1 && args[harnessIndex + 1]
  ? resolve(args[harnessIndex + 1])
  : join(process.env.APPDATA || '', 'dsh-desktop', 'harness')

const fail = (message) => {
  console.error(`[install] 失败：${message}`)
  process.exit(1)
}
const note = (message) => console.log(`[install] ${message}`)
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')

const sourcePackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = sourcePackage.version

// 0. 校验来源与目标 ------------------------------------------------------------
if (!existsSync(harnessHome)) fail(`找不到 Harness 目录：${harnessHome}`)
const profileDir = join(harnessHome, 'profiles', 'web')
const generationsDir = join(harnessHome, 'profiles', '.generations')
const profileJsonPath = join(profileDir, 'package.json')
const desiredPath = join(generationsDir, 'desired.json')
for (const file of [profileJsonPath, desiredPath]) {
  if (!existsSync(file)) fail(`缺少 ${file}`)
}
for (const entry of [...PACKAGE_ENTRIES, ...PACKAGE_DIRS]) {
  if (!existsSync(join(ROOT, entry))) fail(`工作区缺少 ${entry}，请先运行 node scripts/sync-app.mjs`)
}

// 必须有一个 tgz 落到磁盘并长期保留：它就是管理器记录的安装来源。
const tgzName = `${PACKAGE_NAME}-${version}.tgz`
const tgzPath = join(ROOT, tgzName)
if (!existsSync(tgzPath)) {
  fail(`缺少 ${tgzName}：请先运行 pnpm pack。它必须保留在磁盘上，否则管理器无法按记录重新物化。`)
}

// 1. 计算代际 ID 与目标目录 ---------------------------------------------------
// 12 位十六进制；管理器只是拿它当唯一标识（同版本重复安装也会不同），所以随机即可。
// 若同名目录已存在（重复运行），复用已有 ID，保证幂等。
const liveDir = join(generationsDir, 'live')
const existing = existsSync(liveDir)
  ? readdirSync(liveDir).find((name) => name.startsWith(`${PACKAGE_NAME}+${version}+`))
  : undefined
const generationId = existing || `${PACKAGE_NAME}+${version}+${randomBytes(6).toString('hex')}`
const generationDir = join(liveDir, generationId)
const packageDir = join(generationDir, 'node_modules', PACKAGE_NAME)

const profile = JSON.parse(readFileSync(profileJsonPath, 'utf8'))
const desired = JSON.parse(readFileSync(desiredPath, 'utf8'))
const linkValue = `link:../.generations/live/${generationId}/node_modules/${PACKAGE_NAME}`

note(`来源：${tgzName}（保留在磁盘）`)
note(`代际：${generationId}`)
note(`目标：${packageDir}`)
note(`profile 当前依赖该插件：${Boolean(profile.dependencies && profile.dependencies[PACKAGE_NAME])}`)

if (dryRun) {
  note(`--dry-run：将写入 ${profileJsonPath}（dependencies / bundles / generationProjection / pnpm.overrides）`)
  note(`--dry-run：将写入 ${desiredPath}`)
  note(`--dry-run：将创建 ${generationDir} 与 profiles/web/node_modules/${PACKAGE_NAME} 链接`)
  process.exit(0)
}

// 2. 备份托管状态 -------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
for (const file of [profileJsonPath, desiredPath]) {
  cpSync(file, `${file}.bak-${stamp}`, { force: true })
}
note(`已备份 profile 记录（*.bak-${stamp}）`)

// 3. 物化代际目录 -------------------------------------------------------------
// 脚手架文件按同级代际的样式复制，保证管理器认得出这是它自己的目录结构。
mkdirSync(packageDir, { recursive: true })
const sibling = existsSync(liveDir)
  ? readdirSync(liveDir).map((name) => join(liveDir, name)).find((dir) => {
    return existsSync(join(dir, 'generation.json')) && dir !== generationDir
  })
  : undefined
for (const file of ['pnpm-workspace.yaml', '.npmrc', 'pnpm-lock.yaml']) {
  if (sibling && existsSync(join(sibling, file))) cpSync(join(sibling, file), join(generationDir, file), { force: true })
}
if (!existsSync(join(generationDir, 'pnpm-workspace.yaml'))) {
  writeFileSync(join(generationDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8')
}
writeJson(join(generationDir, 'generation.json'), { pluginName: PACKAGE_NAME, version })
writeJson(join(generationDir, 'package.json'), {
  name: 'dsh-generation',
  private: true,
  version: '0.0.0',
  dependencies: { [PACKAGE_NAME]: `file:${tgzPath.replace(/\\/g, '/')}` }
})

// 拷贝包本体（覆盖旧内容，保持与工作区一致）。
if (existsSync(packageDir)) rmSync(packageDir, { recursive: true, force: true })
mkdirSync(packageDir, { recursive: true })
for (const directory of PACKAGE_DIRS) {
  cpSync(join(ROOT, directory), join(packageDir, directory), { recursive: true, force: true })
}
for (const file of PACKAGE_ENTRIES) {
  cpSync(join(ROOT, file), join(packageDir, file), { force: true })
}
note(`已物化包本体（${PACKAGE_DIRS.length} 个目录 + ${PACKAGE_ENTRIES.length} 个文件）`)

// 本包的运行时依赖（@deepseek-ai/schemastery）在 profile 顶层是 hoisted 的，Node 会沿
// 目录向上找到它；这里再把能拿到的依赖复制进代际目录，避免依赖解析行为与官方安装不同。
const runtimeDeps = ['@deepseek-ai/schemastery', '@standard-schema/spec']
for (const dep of runtimeDeps) {
  const from = join(harnessHome, 'profiles', 'node_modules', dep)
  const to = join(generationDir, 'node_modules', dep)
  if (!existsSync(from)) {
    note(`提示：${dep} 不在 profiles/node_modules，交由 Node 向上解析`)
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true, force: true })
}

// 4. 七处记录 ----------------------------------------------------------------
profile.dependencies = profile.dependencies || {}
const dependencies = {}
for (const [key, value] of Object.entries(profile.dependencies)) {
  dependencies[key] = value
  if (key === PACKAGE_NAME) delete dependencies[key]
}
dependencies[PACKAGE_NAME] = version
profile.dependencies = dependencies

const bundles = (profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || []
if (!bundles.includes(PACKAGE_NAME)) {
  profile.dsh.profile.bundles = [...bundles.filter((name) => name !== PACKAGE_NAME), PACKAGE_NAME]
}

const projection = profile.dsh.desktop.generationProjection
projection.plugins[PACKAGE_NAME] = {
  generationId,
  visibleVersion: version,
  previousOverride: { present: false }
}

profile.pnpm = profile.pnpm || {}
profile.pnpm.overrides = profile.pnpm.overrides || {}
profile.pnpm.overrides[PACKAGE_NAME] = linkValue

writeJson(profileJsonPath, profile)
note('已写入 profile：dependencies / bundles / generationProjection / pnpm.overrides')

const desiredNext = desired.includes(generationId)
  ? desired.filter((id) => !id.startsWith(`${PACKAGE_NAME}+`) || id === generationId)
  : [...desired.filter((id) => !id.startsWith(`${PACKAGE_NAME}+`)), generationId]
writeJson(desiredPath, desiredNext)
note('已写入 desired.json')

// 7. profile 里的 Junction ----------------------------------------------------
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)
mkdirSync(dirname(linkPath), { recursive: true })
rmSync(linkPath, { recursive: true, force: true })
try {
  // 目录联接无需管理员权限，与官方安装产出的形态一致。
  const { symlinkSync } = await import('node:fs')
  symlinkSync(packageDir, linkPath, 'junction')
  note(`已创建 Junction：profiles/web/node_modules/${PACKAGE_NAME}`)
} catch (error) {
  fail(`创建 Junction 失败（${(error && error.message) || error}）。请以管理员身份重试，或手动将该目录指向 ${packageDir}`)
}

// 5. 自检 --------------------------------------------------------------------
const installed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
if (installed.version !== version) fail(`物化后版本不一致：${installed.version} ≠ ${version}`)

const countFiles = (directory) => {
  let total = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else total += 1
    }
  }
  walk(directory)
  return total
}
const expectedFiles = PACKAGE_DIRS.reduce((total, d) => total + countFiles(join(ROOT, d)), 0) + PACKAGE_ENTRIES.length
const actualFiles = countFiles(packageDir)
if (expectedFiles !== actualFiles) fail(`物化后文件数不一致：${actualFiles} ≠ ${expectedFiles}`)

// 画布产物的定制标记：证明装进去的确实是带 overlay 的新构建，而不是白板项目原版。
const BUNDLE_MARKERS = [
  '/api/dsh-draw-workbench', // overlay 的应用外壳把数据读写接到了本插件
  '/session/data' // 自动保存端点（overlay 里以拼接形式出现，产物中为字面量）
]
const bundleDirectory = join(packageDir, 'app', 'assets')
let bundleText = ''
for (const file of readdirSync(bundleDirectory)) {
  if (file.endsWith('.js')) bundleText += readFileSync(join(bundleDirectory, file), 'utf8')
}
for (const marker of BUNDLE_MARKERS) {
  if (!bundleText.includes(marker)) fail(`画布产物缺少标记「${marker}」，可能装到了旧构建`)
}
if (bundleText.includes('cloud.umami.is')) fail('画布产物仍引用第三方统计脚本')

const checkProfile = JSON.parse(readFileSync(profileJsonPath, 'utf8'))
for (const [label, ok] of [
  ['dependencies', checkProfile.dependencies[PACKAGE_NAME] === version],
  ['bundles', checkProfile.dsh.profile.bundles.includes(PACKAGE_NAME)],
  ['generationProjection', checkProfile.dsh.desktop.generationProjection.plugins[PACKAGE_NAME]?.generationId === generationId],
  ['pnpm.overrides', checkProfile.pnpm.overrides[PACKAGE_NAME] === linkValue]
]) {
  if (!ok) fail(`profile 记录未写正确：${label}`)
}
if (!existsSync(linkPath)) fail('Junction 未建立')

console.log(`[install] 完成：${PACKAGE_NAME} ${version}，${actualFiles} 个文件，代际 ${generationId}`)
console.log(`[install] 记录的安装来源：${tgzPath}`)
console.log('[install] 不要删除这个 tgz：管理器按它做重新物化，删了会在下次启动时清掉插件。')
console.log('[install] 下一步：完全退出并重新打开 DSH Desktop，然后到「工作台」查看。')
