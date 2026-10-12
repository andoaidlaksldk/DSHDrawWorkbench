#!/usr/bin/env node
/**
 * DSHDrawWorkbench 自检脚本。
 *
 * 覆盖四件事，全部为确定性检查：
 *   1. 包与产物完整性：清单必填字段、cordis.patch.yml、app/ 落盘文件数、宿主页净化、
 *      路由段字符要求（非法文件名会打死整个 Harness，是硬约束）、文本无 NUL；
 *   2. 服务端接口：用内存宿主 + 临时数据目录真跑一遍路由（静态托管、会话读写、
 *      文档增删改名与「删除后不许复活」的竞态回归、偏好设置）；
 *   3. 画板数据模型：紧凑描述 → 元素、元素 → 可读文本、数据归一化；
 *   4. Agent 工具：真实执行 board_list / board_read / board_write，检查落盘内容；
 *   5. 客户端：加载协议、注册字段，以及**三处接口前缀/通道名的一致性**
 *      （服务端、面板、画布 overlay 必须完全一致，否则界面静默失联）。
 *
 * 用法：node scripts/verify.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

register('./stub-loader.mjs', import.meta.url)

// 在真实 Harness 里，插件抛在异步链中的异常会变成 unhandled rejection，
// 最终 `dsh: fatal load failure` 打死整个进程（不只是本插件失效）。
// 自检里把它当成硬失败，避免这类致命问题再次溜过去。
process.on('unhandledRejection', (error) => {
  console.error('\n[verify] 出现 unhandled rejection（真实环境中等价于 dsh: fatal load failure）：')
  console.error(error)
  process.exit(1)
})

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(root, 'app')
const PACKAGE_NAME = 'dsh-draw-workbench'
let checks = 0

function ok(label) {
  checks += 1
  console.log(`  \u2713 ${label}`)
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function walk(directory, prefix = '') {
  const out = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(join(directory, entry.name), relative))
    else out.push(relative)
  }
  return out
}

// --------------------------------------------------------------- 1. 包与产物 --

console.log('[verify] 包与产物')

const manifest = readJsonFile(join(root, 'package.json'))
assert.equal(manifest.name, PACKAGE_NAME, '包名必须是 dsh-draw-workbench')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须指向 cordis.patch.yml')
assert.equal(manifest.dsh?.client?.platform, 'web', 'dsh.client.platform 必须为 web')
assert.ok(manifest.dsh.client.inject.includes('dsh-desktop-workbenches'), 'dsh.client.inject 必须包含 dsh-desktop-workbenches')
assert.ok(manifest.exports?.['./client'], 'exports["./client"] 必须存在')
assert.ok(manifest.files.includes('app'), 'files 必须包含 app 目录')
assert.equal(
  manifest.repository?.url,
  'git+https://github.com/andoaidlaksldk/DSHDrawWorkbench.git',
  'package.json 的 repository 必须指向本仓库'
)
ok('package.json 声明插件入口、注入点、打包范围与仓库地址')

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
assert.ok(patch.includes(`name: ${PACKAGE_NAME}`), 'cordis.patch.yml 必须按包名插入')
assert.ok(patch.includes("dshHomePath('draw-workbench')"), 'cordis.patch.yml 必须声明数据目录 draw-workbench')
ok('cordis.patch.yml 按包名插入并声明数据目录')

assert.ok(existsSync(join(appRoot, 'index.html')), '缺少 app/index.html')
const appAssets = walk(appRoot).filter((file) => file.startsWith('assets/') && file.endsWith('.js'))
assert.ok(appAssets.length > 0, 'app/assets 下没有构建产物')
const appFiles = walk(appRoot)
assert.ok(appFiles.length > 40, `app/ 文件数异常：${appFiles.length}`)
ok(`app/ 已落地 ${appFiles.length} 个文件（含 ${appAssets.length} 个构建脚本）`)

// 品牌素材必须是我们自己的设计，且 app/ 下不允许出现以上游品牌命名的文件
// （上游 public/logo、public/product_showcase 里的素材由 canvas-overlay.mjs 整体替换）。
const BRAND_FILES = [
  'logo/logo_h.svg',
  'logo/logo_h_dark.svg',
  'product_showcase/case-1.svg',
  'product_showcase/case-2.svg'
]
for (const file of BRAND_FILES) {
  assert.ok(appFiles.includes(file), `缺少品牌素材 app/${file}`)
}
const brandLeaks = appFiles.filter((file) => /drawnix|plait/i.test(file))
assert.deepEqual(brandLeaks, [], `app/ 下仍有以上游品牌命名的文件：${brandLeaks.join('、')}`)
ok(`品牌素材已换成自有设计（${BRAND_FILES.length} 个文件），且无上游品牌命名文件`)

// 位图版素材：既要存在，也不能比矢量源文件旧（否则等于交付了过期设计）。
for (const file of BRAND_FILES) {
  const bitmap = join(appRoot, file.replace(/\.svg$/, '.png'))
  const vector = join(appRoot, file)
  assert.ok(existsSync(bitmap), `缺少位图素材 app/${file.replace(/\.svg$/, '.png')}（运行 npm run brand:render）`)
  assert.ok(
    statSync(bitmap).mtimeMs >= statSync(vector).mtimeMs,
    `位图 app/${file.replace(/\.svg$/, '.png')} 早于矢量源文件，请重新运行 npm run brand:render`
  )
}
ok(`品牌素材同时提供矢量与位图两套（各 ${BRAND_FILES.length} 个），位图不比矢量源文件旧`)

// 路由段的合法字符由 Harness 固定为 `[A-Za-z0-9_$.-]`（见应用内 ENDPOINT_SEGMENT_PATTERN）。
// 文件名违规会让 register 被判为 invalid exact Fetch route——这是曾经打死 Harness 的原因，
// 所以这里当成硬约束：`app/` 下不允许出现任何不合规文件名。
const ILLEGAL_SEGMENT = /[^A-Za-z0-9_$.-]/
const illegalNames = appFiles.filter((file) => file.split('/').some((segment) => segment === '' || ILLEGAL_SEGMENT.test(segment)))
assert.deepEqual(illegalNames, [], `app/ 下存在不合规文件名（只允许 A-Za-z0-9_$.-）：${illegalNames.join('、')}`)
ok('app/ 下所有文件名都满足路由段字符要求（无百分号编码/非 ASCII）')

for (const file of ['package.json', 'cordis.patch.yml', 'dsh/index.js', 'lib/client.js', 'app/index.html']) {
  const buffer = readFileSync(join(root, file))
  assert.equal(buffer.includes(0), false, `${file} 含 NUL 字节（写入损坏）`)
}
ok('关键文本文件不含 NUL 字节')

// 宿主页：剥离统计脚本与绝对根 base，标题用工作台自己的名字，资源用相对路径。
const appHtml = readFileSync(join(appRoot, 'index.html'), 'utf8')
const appMarkup = appHtml.replace(/<!--[\s\S]*?-->/g, '')
assert.equal(/<script[^>]*umami/i.test(appMarkup), false, 'app/index.html 仍含第三方统计脚本')
assert.equal(/<base\s[^>]*href\s*=\s*"\/"/i.test(appMarkup), false, 'app/index.html 仍含绝对根 base（子路径托管会白屏）')
assert.ok(appHtml.includes('<title>DSH 画板</title>'), 'app/index.html 的标题应为「DSH 画板」')
assert.ok(/="\.\/assets\//.test(appMarkup), 'app/index.html 的资源必须是相对路径（./assets/…）')
ok('宿主页已剥离统计脚本与绝对 base，标题与资源路径符合子路径托管')

// 画布 overlay 必须真的编进产物：否则界面只是个空壳。
const bundleTexts = appAssets.map((file) => readFileSync(join(appRoot, file), 'utf8'))
const overlayBundles = bundleTexts.filter((text) => text.includes(`/api/${PACKAGE_NAME}`))
assert.equal(overlayBundles.length, 1, `应有且仅有一个产物含画布 overlay 的接口前缀，实际 ${overlayBundles.length}`)
assert.equal(bundleTexts.some((text) => text.includes('cloud.umami.is')), false, '画布产物里仍然引用了统计域名')
ok('画布 overlay（服务端接口读写）已编进产物，且不含统计域名')

// 界面文案里的上游品牌/链接必须已由 scripts/canvas-overlay.mjs 的补丁表清掉
// （只允许保留标识符：组件名、枚举键、MIME 常量、CSS 类名）。
const allBundles = bundleTexts.join('\n')
assert.ok(allBundles.includes('github.com/andoaidlaksldk/DSHDrawWorkbench'), '「更多」菜单的 GitHub 链接没有改成本仓库')
assert.equal(allBundles.includes('plait-board/drawnix'), false, '画布产物里仍指向上游仓库')
assert.equal(allBundles.includes('Drawnix file'), false, '打开/保存文件对话框的描述仍是上游品牌名')
assert.equal(allBundles.includes('DPIT'), false, '语言包里残留了上游分支的品牌名')
ok('界面里的上游品牌名与仓库链接已清除（菜单 GitHub 指向本仓库）')

// ------------------------------------------------------------------ 2. 服务端 --

console.log('[verify] 服务端接口（内存宿主 + 临时数据目录）')

const serverModule = await import(pathToFileURL(join(root, 'dsh', 'index.js')).href)
const { apply, Config, boardSpecToElements, boardToText, elementText, normalizeBoardData, registerBoardTools } = serverModule

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-draw-verify-'))

/**
 * 严格宿主替身：复刻 Harness「同一精确路径只能登记一次」的契约。
 * 拆成两条 register 注册同一路径时，真实 Harness 会抛错并让插件接口全 404——
 * 这个替身能提前把它变成自检失败。
 */
function createHost({ failOn } = {}) {
  const routes = []
  const rejected = []
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          if (failOn && failOn(route)) {
            rejected.push(route.path)
            throw new Error(`invalid exact Fetch route "${route.path}"`)
          }
          if (routes.some((item) => item.path === route.path)) {
            throw new Error(`connection: exact Fetch route "${route.path}" is already registered`)
          }
          routes.push(route)
          return () => routes.splice(routes.indexOf(route), 1)
        }
      }
    },
    tools: { register(tool) { registeredTools.push(tool); return () => {} } },
    systemPrompt: { section() { return () => {} } },
    inject() { return () => {} },
    effect(callback) { return callback() }
  }
  const registeredTools = []
  return { ctx, routes, registeredTools, rejected }
}

async function call(host, path, init) {
  const route = host.routes.find((item) => item.path.startsWith('/api/') && item.path === `/api/${PACKAGE_NAME}${path}`)
  if (!route) return { status: 404, body: null, missing: true }
  if (init?.method && !route.methods.includes(init.method)) return { status: 405, body: null }
  const request = new Request(`http://127.0.0.1${route.path}`, init)
  const response = await route.fetch(request)
  const type = response.headers.get('content-type') || ''
  const body = type.includes('json') ? await response.json() : await response.text()
  return { status: response.status, body, headers: response.headers }
}

const post = (host, path, value) => call(host, path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value)
})

const host = createHost()
apply(host.ctx, { root: dataRoot })

// 健康检查
const health = await call(host, '/health')
assert.equal(health.status, 200)
assert.equal(health.body.ok, true)
assert.equal(health.body.name, PACKAGE_NAME)
assert.ok(health.body.files > 40, `静态托管文件数异常：${health.body.files}`)
assert.deepEqual(health.body.skipped, [], '不应有被跳过的静态路径')
ok(`/health 就绪（托管 ${health.body.files} 个静态文件）`)

// 启动即建默认文档
const session1 = await call(host, '/session')
assert.equal(session1.status, 200)
assert.equal(session1.body.documentId, 'default')
assert.deepEqual(session1.body.document.data.elements, [])
assert.equal(session1.body.document.data.type, 'drawnix')
assert.equal(session1.body.document.data.viewport.zoom, 1)
ok('首次访问自动创建默认画板（空画板 + 合法 viewport）')

// 保存 → 读回
const board = {
  type: 'drawnix',
  version: 1,
  source: 'web',
  elements: [
    { id: 'a', type: 'geometry', shape: 'rectangle', points: [[0, 0], [200, 80]], text: { type: 'paragraph', children: [{ text: '需求评审' }] } },
    { id: 'b', type: 'arrow-line', shape: 'straight', points: [[100, 80], [100, 200]], source: { marker: 'none' }, target: { marker: 'arrow' }, texts: [], opacity: 1 }
  ],
  viewport: { zoom: 1.25 }
}
const saved = await post(host, '/session/data', { documentId: 'default', data: board })
assert.equal(saved.status, 200)
assert.ok(saved.body.updatedAt, '保存应返回 updatedAt')
const session2 = await call(host, '/session')
assert.equal(session2.body.document.data.elements.length, 2)
assert.equal(session2.body.document.data.viewport.zoom, 1.25)
ok('画板数据可保存并原样读回（elements 与 viewport 均保留）')

// 兼容画布内部状态（children）：归一化成 elements
const compat = await post(host, '/session/data', {
  documentId: 'default',
  data: { children: [{ id: 'x', type: 'geometry', shape: 'ellipse', points: [[0, 0], [40, 40]] }] }
})
assert.equal(compat.status, 200)
const session3 = await call(host, '/session')
assert.equal(session3.body.document.data.elements.length, 1, 'children 写法应被归一化成 elements')
assert.equal(session3.body.document.data.type, 'drawnix')
ok('画布内部的 children 写法被归一化成标准 .drawnix 数据')

// 不存在的文档不许被保存「救活」
const ghost = await post(host, '/session/data', { documentId: 'board-does-not-exist', data: { elements: [] } })
assert.equal(ghost.status, 404, '对不存在的文档保存必须 404，否则删除后会被自动保存复活')
ok('拒绝为不存在的文档保存（删除后复活的竞态回归）')

// 非法数据
assert.equal((await post(host, '/session/data', { documentId: 'default', data: { viewport: {} } })).status, 400)
assert.throws(() => normalizeBoardData({ hello: 1 }), /elements/)
assert.throws(() => normalizeBoardData(null), /对象/)
ok('缺少 elements 的画板数据被拒绝')

// 文档增删改查
const created = await post(host, '/documents', { action: 'create', name: '上线流程' })
assert.equal(created.status, 200)
assert.equal(created.body.document.name, '上线流程')
const createdId = created.body.activeDocumentId
assert.match(createdId, /^board-/, '新建文档 id 应有 board- 前缀')
assert.equal(created.body.documents.length, 2)

const renamed = await post(host, '/documents', { action: 'rename', id: createdId, name: '上线流程 v2' })
assert.equal(renamed.body.documents.find((doc) => doc.id === createdId).name, '上线流程 v2')

const duplicated = await post(host, '/documents', { action: 'duplicate', id: createdId })
const duplicateId = duplicated.body.activeDocumentId
assert.equal(duplicated.body.documents.length, 3)
assert.ok(duplicated.body.documents.find((doc) => doc.id === duplicateId).name.includes('副本'))

const opened = await post(host, '/documents', { action: 'open', id: 'default' })
assert.equal(opened.body.activeDocumentId, 'default')
assert.ok(opened.body.document.data.elements, 'open 动作必须带回该文档的画板数据')

const deleted = await post(host, '/documents', { action: 'delete', id: createdId })
assert.equal(deleted.body.documents.length, 2)
assert.equal((await post(host, '/documents', { action: 'delete', id: 'default' })).status, 400)
assert.equal((await post(host, '/documents', { action: 'nonsense' })).status, 400)
ok('文档 create / rename / duplicate / open / delete 行为正确（默认文档不可删）')

// 导入（.drawnix 原样）
const imported = await post(host, '/documents', {
  action: 'import',
  name: '导入的画板',
  data: board
})
assert.equal(imported.status, 200)
assert.equal(imported.body.document.data.elements.length, 2)
ok('导入 .drawnix 数据成功')

// 偏好设置
assert.equal((await post(host, '/session/preferences', { preference: { language: 'en' } })).status, 200)
assert.equal((await post(host, '/session/preferences', { preference: 'nope' })).status, 400)
assert.equal((await call(host, '/session')).body.preference.language, 'en')
ok('偏好设置可保存、并在会话启动时回读')

// 静态托管
const page = await call(host, '/app/index.html')
assert.equal(page.status, 200)
assert.ok(page.body.includes('DSH 画板'))
assert.equal((await call(host, '/app/does-not-exist.js')).status, 404)
assert.equal((await call(host, '/app/%E4%B8%AD%E6%96%87.svg')).status, 404, '非 ASCII 路径不应命中任何路由')
ok('静态托管：入口页 200、不存在 404、百分号编码路径不命中')

// 宿主拒绝某条路由时，插件必须活下来（并记录被拒路径），绝不能打死 Harness。
const hostile = createHost({ failOn: (route) => route.path.endsWith('.html') })
apply(hostile.ctx, { root: mkdtempSync(join(tmpdir(), 'dsh-draw-verify-hostile-')) })
assert.ok(hostile.rejected.length >= 1, '被宿主拒绝的路径应被记录')
const hostileHealth = await call(hostile, '/health')
assert.equal(hostileHealth.status, 200, '有路由被拒时其余接口仍须可用')
assert.ok(hostileHealth.body.rejected.length >= 1, '/health 应暴露被拒绝的路由')
ok('宿主拒绝部分路由时插件仍正常装载（不再演变为 fatal load failure）')

// ------------------------------------------------------------ 3. 画板数据模型 --

console.log('[verify] 画板数据模型')

const spec = {
  title: '上线流程',
  nodes: [
    { id: 'a', text: '需求评审' },
    { id: 'b', text: '开发', shape: 'rectangle' },
    { id: 'c', text: '上线' }
  ],
  edges: [
    { from: 'a', to: 'b', label: '通过' },
    { from: 'a', to: 'c' }
  ]
}
const elements = boardSpecToElements(spec)
const shapes = elements.filter((element) => element.type === 'geometry')
const arrows = elements.filter((element) => element.type === 'arrow-line')
assert.equal(shapes.length, 4, '应有 1 个标题 + 3 个节点')
assert.equal(arrows.length, 2)
assert.equal(arrows[0].target.marker, 'arrow')
assert.equal(arrows[0].texts[0].text.children[0].text, '通过')
// 分层布局：入度为 0 的 a 在第 0 层，b 与 c 是它的下一层（同一行不同列）。
const byId = new Map(shapes.map((element) => [element.id, element]))
assert.equal(byId.get('a').points[0][1], 0)
assert.ok(byId.get('b').points[0][1] > byId.get('a').points[0][1])
assert.equal(byId.get('b').points[0][1], byId.get('c').points[0][1], '同层节点应在同一行')
assert.ok(byId.get('b').points[0][0] !== byId.get('c').points[0][0], '同层节点不应重叠')
// 显式坐标优先
const placed = boardSpecToElements({ nodes: [{ id: 'a', text: 'A', x: 500, y: 700 }] })
assert.deepEqual(placed[0].points[0], [500, 700])
assert.throws(() => boardSpecToElements({ edges: [] }), /nodes/)
assert.throws(() => boardSpecToElements({ elements: [] }), /elements/)
ok('紧凑描述 → 元素：分层布局、标签、显式坐标优先、缺 nodes 被拒')

assert.equal(elementText(shapes[1]), '需求评审')
assert.equal(elementText({ data: { topic: { type: 'paragraph', children: [{ text: '中心' }] } } }), '中心')
assert.equal(elementText({ texts: [{ text: { children: [{ text: '标签' }] } }] }), '标签')
const rendered = boardToText(elements)
assert.ok(rendered.includes('[矩形] 需求评审'))
// 连线是按坐标反查两端图形的（工具写出的线不做 boundId 绑定），所以这里应看到图形名字。
assert.ok(rendered.includes('[连线] 需求评审 → 开发：通过'), `连线应能反查到两端图形，实际：\n${rendered}`)
ok('元素 → 可读文本（几何 / 连线 / 思维导图三种文本位置都能取到）')

// ------------------------------------------------------------- 4. Agent 工具 --

console.log('[verify] Agent 工具（真实执行）')

const { defineTool } = await import('@deepseek-ai/dsh-tools')
const toolScope = createHost()
const toolsRoot = mkdtempSync(join(tmpdir(), 'dsh-draw-tools-'))
registerBoardTools(toolScope.ctx, defineTool, toolsRoot)
const tools = new Map(toolScope.registeredTools.map((tool) => [tool.name, tool]))
assert.deepEqual([...tools.keys()].sort(), ['board_list', 'board_read', 'board_write'])
for (const tool of tools.values()) {
  assert.ok(tool.output?.render, `${tool.name} 必须声明文本输出渲染器`)
}
ok('board_list / board_read / board_write 三个工具注册成功且声明文本输出')

const listEmpty = await tools.get('board_list').execute({})
assert.ok(listEmpty.includes('default'), 'board_list 应列出默认画板')

const toolsDocsDir = join(toolsRoot, 'documents')
const readToolDocs = () => readdirSync(toolsDocsDir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => JSON.parse(readFileSync(join(toolsDocsDir, file), 'utf8')))
const docNamed = (name) => readToolDocs().find((document) => document.name === name)

const written = await tools.get('board_write').execute({
  board: JSON.stringify(spec),
  name: '流程图'
})
assert.ok(written.includes('流程图'))
// 不带 documentId 时工具会**新建**一块画板（与思维导图工作台一致，避免覆盖用户正在画的内容）。
const writtenDoc = docNamed('流程图')
assert.ok(writtenDoc, 'board_write 应新建名为「流程图」的画板')
assert.equal(writtenDoc.data.elements.filter((element) => element.type === 'arrow-line').length, 2)
assert.equal(writtenDoc.data.type, 'drawnix', '落盘数据必须是标准 .drawnix 结构')

const read = await tools.get('board_read').execute({ documentId: writtenDoc.id })
assert.ok(read.includes('[矩形] 开发'))
assert.ok(read.includes('[连线] 需求评审 → 开发'), `board_read 应能反查连线两端，实际：\n${read}`)
assert.ok(read.includes('共 6 个元素'), `board_read 应报出元素总数，实际：${read.slice(0, 80)}`)

// 追加模式：不覆盖已有内容
const appended = await tools.get('board_write').execute({
  board: JSON.stringify({ nodes: [{ id: 'z', text: '追加节点' }] }),
  documentId: writtenDoc.id,
  mode: 'append'
})
assert.ok(appended.includes('追加'))
const afterAppend = docNamed('流程图')
assert.equal(afterAppend.data.elements.filter((element) => element.type === 'geometry').length, 5)

// 覆盖模式：整体替换
await tools.get('board_write').execute({
  board: JSON.stringify({ nodes: [{ id: 'only', text: '只剩一个' }] }),
  documentId: writtenDoc.id
})
assert.equal(docNamed('流程图').data.elements.length, 1)

// 缺必填参数与非法输入
await assert.rejects(() => tools.get('board_write').execute({}), /board is required/)
await assert.rejects(() => tools.get('board_write').execute({ board: '{ not json' }), /合法 JSON/)
await assert.rejects(() => tools.get('board_read').execute({ documentId: '不合法 id' }), /文档标识/)
await assert.rejects(() => tools.get('board_read').execute({ documentId: 'board-missing' }), /文档不存在/)
ok('工具真实写盘：新建/追加/覆盖均正确，缺参非法输入被拒')

// 输出上限：大画板必须截断，否则一次读取就挤爆上下文
const bigId = docNamed('流程图').id
await tools.get('board_write').execute({
  board: JSON.stringify({ nodes: Array.from({ length: 320 }, (_, index) => ({ id: `n${index}`, text: `节点${index}` })) }),
  documentId: bigId
})
const bigRead = await tools.get('board_read').execute({ documentId: bigId })
assert.ok(bigRead.includes('未显示'), '超大画板的读取结果必须被截断')
ok('超大画板读取被截断（保护对话上下文）')

// ------------------------------------------------------------------ 5. 客户端 --

console.log('[verify] 客户端入口')

const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
assert.ok(clientSource.includes('window.__ModuleLoader__.load'), '必须使用 __ModuleLoader__.load 协议')
assert.ok(clientSource.includes(`id: '${PACKAGE_NAME}'`), '客户端 id 必须与包名一致')
for (const marker of ['desktopWorkbenches.register', 'customFrame: true', 'ctx.locale.register', 'DSH 画板',
  "REPOSITORY = 'https://github.com/andoaidlaksldk/DSHDrawWorkbench'", 'repository: REPOSITORY']) {
  assert.ok(clientSource.includes(marker), `客户端缺少要素：${marker}`)
}
assert.equal(/register\(\s*\{[^}]*\bid\s*:/.test(clientSource), false, 'register() 不得声明旧的 id 字段')
assert.deepEqual(JSON.parse(JSON.stringify(serverModule.inject)), ['connection', 'tools', 'systemPrompt'])
assert.ok(clientSource.includes("inject: ['desktopWorkbenches', 'locale']"), '客户端 inject 必须声明 desktopWorkbenches 与 locale')
ok('客户端加载协议、注册字段与注入点正确')

// 三处前缀/通道必须完全一致：服务端、面板、画布 overlay。
const overlaySource = readFileSync(join(root, 'overlay', 'app.tsx'), 'utf8')
const extract = (source, pattern) => (source.match(pattern) || [])[1]
const serverApi = `/api/${PACKAGE_NAME}`
const clientApi = extract(clientSource, /const API = '([^']+)'/)
const overlayApi = extract(overlaySource, /const API = '([^']+)'/)
assert.equal(clientApi, serverApi, `面板接口前缀 ${clientApi} 与服务端 ${serverApi} 不一致`)
assert.equal(overlayApi, serverApi, `画布 overlay 接口前缀 ${overlayApi} 与服务端 ${serverApi} 不一致`)
const clientChannel = extract(clientSource, /const CHANNEL = '([^']+)'/)
const overlayChannel = extract(overlaySource, /const CHANNEL = '([^']+)'/)
assert.equal(clientChannel, PACKAGE_NAME)
assert.equal(overlayChannel, clientChannel, `画布 overlay 通道名 ${overlayChannel} 与面板 ${clientChannel} 不一致`)
for (const type of ['load', 'flush', 'snapshot']) {
  assert.ok(overlaySource.includes(`'${type}'`) && clientSource.includes(`type: '${type}'`), `两侧协议缺少消息类型：${type}`)
}
ok('服务端 / 面板 / 画布 overlay 的接口前缀与 postMessage 协议一致')

// 数据目录名必须与 cordis 补丁一致。
assert.ok(patch.includes('draw-workbench', 'draw-workbench'))

rmSync(dataRoot, { recursive: true, force: true })
rmSync(toolsRoot, { recursive: true, force: true })

console.log(`\n[verify] 全部通过（${checks} 项）`)
