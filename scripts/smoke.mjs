#!/usr/bin/env node
/**
 * DSHDrawWorkbench 冒烟测试。
 *
 * 与 `verify.mjs` 的区别：verify 做的是确定性单元/接口自检（内存宿主直接调路由），
 * 本脚本把插件真实地跑成一台 HTTP 服务，用真实网络请求打一遍完整链路，
 * 供人工或浏览器做界面级冒烟：
 *
 *   1. HTTP 冒烟（自动，总是执行）
 *      - 静态资源：入口页、构建脚本、HEAD、404、百分号编码路径
 *      - 画布启动链路：GET /session
 *      - 自动保存链路：POST /session/data → 落盘 → 再 GET /session 读回
 *      - 文档管理：create/open/rename/duplicate/delete
 *      - 偏好设置
 *   2. 界面冒烟（--serve 时由浏览器驱动）
 *      启动常驻服务并打印 `SMOKE_READY <url>`，配合浏览器打开入口页，
 *      验证画布挂载，再用 `--check-disk <关键字>` 断言浏览器里的编辑已经落盘。
 *
 * 用法：
 *   node scripts/smoke.mjs                        # 只跑 HTTP 冒烟
 *   node scripts/smoke.mjs --serve                # 跑完 HTTP 冒烟后常驻服务
 *   node scripts/smoke.mjs --check-disk 冒烟内容   # 断言数据目录里出现该关键字
 *   node scripts/smoke.mjs --root <目录>           # 指定数据目录（默认临时目录）
 *   node scripts/smoke.mjs --port 7392
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

register('./stub-loader.mjs', import.meta.url)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-draw-workbench'
const API = `/api/${PACKAGE_NAME}`

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const keepServing = process.argv.includes('--serve')
const checkDiskKeyword = arg('--check-disk', null)
const port = Number(arg('--port', 7392))
const explicitRoot = arg('--root', null)
const dataRoot = explicitRoot ? resolve(explicitRoot) : mkdtempSync(join(tmpdir(), 'dsh-draw-smoke-'))

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  \u2713 ${label}`)
}

// ---------------------------------------------------------------- 宿主替身 --

const { apply } = await import(pathToFileURL(join(root, 'dsh', 'index.js')).href)
const routes = []
// 与 verify.mjs 相同的严格替身：复刻 Harness「同一精确路径只能登记一次」的契约，
// 否则「同路径分别注册 GET 与 POST」会让真实 Harness 里的 apply 抛错、插件全部接口 404。
const ctx = {
  connection: {
    fetch: {
      register(route) {
        if (routes.some((item) => item.path === route.path)) {
          throw new Error(`connection: exact Fetch route "${route.path}" is already registered`)
        }
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      }
    }
  },
  tools: { register() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  inject() { return () => {} },
  effect(callback) { return callback() }
}

apply(ctx, { root: dataRoot })

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const route = routes.find((item) => item.path === url.pathname)
  if (!route || !route.methods.includes(request.method)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found')
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const forwarded = new Request(`http://127.0.0.1${request.url}`, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body
  })
  try {
    const result = await route.fetch(forwarded)
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error))
  }
})

await new Promise((done) => server.listen(port, '127.0.0.1', done))
const origin = `http://127.0.0.1:${port}`

const getJson = async (path) => {
  const response = await fetch(`${origin}${path}`)
  const type = response.headers.get('content-type') || ''
  return { status: response.status, body: type.includes('json') ? await response.json() : await response.text() }
}
const postJson = async (path, value) => {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value)
  })
  const type = response.headers.get('content-type') || ''
  return { status: response.status, body: type.includes('json') ? await response.json() : await response.text() }
}

// ---------------------------------------------------------------- HTTP 冒烟 --

console.log(`[smoke] HTTP 冒烟 @ ${origin}（数据目录 ${dataRoot}）`)

const health = await getJson(`${API}/health`)
assert.equal(health.status, 200)
assert.equal(health.body.ok, true)
assert.ok(health.body.files > 40)
assert.deepEqual(health.body.rejected, [])
ok(`健康检查：托管 ${health.body.files} 个静态文件，无被拒路由`)

const page = await fetch(`${origin}${API}/app/index.html`)
assert.equal(page.status, 200)
assert.match(page.headers.get('content-type') || '', /text\/html/)
assert.equal(page.headers.get('cache-control'), 'no-store')
const pageHtml = await page.text()
assert.ok(pageHtml.includes('DSH 画板'))
assert.ok(pageHtml.includes('./assets/'), '入口页必须用相对路径引用资源')
ok('入口页：200 text/html、no-store、标题与相对资源路径正确')

const headPage = await fetch(`${origin}${API}/app/index.html`, { method: 'HEAD' })
assert.equal(headPage.status, 200)
assert.ok(Number(headPage.headers.get('content-length')) > 100)
assert.equal((await headPage.text()).length, 0)
ok('HEAD 请求返回头部且无正文')

const firstBundle = readdirSync(join(root, 'app', 'assets')).filter((name) => name.endsWith('.js')).sort()[0]
const bundle = await fetch(`${origin}${API}/app/assets/${firstBundle}`)
assert.equal(bundle.status, 200)
assert.match(bundle.headers.get('content-type') || '', /javascript/)
assert.ok((await bundle.text()).length > 0)
ok(`构建脚本可访问：assets/${firstBundle}`)

assert.equal((await getJson(`${API}/app/missing-file.js`)).status, 404)
assert.equal((await getJson(`${API}/app/%E4%B8%AD%E6%96%87.svg`)).status, 404)
ok('不存在的资源与非 ASCII 路径都返回 404（不会命中路由）')

const session = await getJson(`${API}/session`)
assert.equal(session.status, 200)
assert.equal(session.body.documentId, 'default')
assert.equal(session.body.document.data.viewport.zoom, 1)
ok('画布启动链路：GET /session 返回默认画板与合法 viewport')

const board = {
  type: 'drawnix',
  version: 1,
  source: 'web',
  elements: [
    { id: 'rect-1', type: 'geometry', shape: 'rectangle', points: [[0, 0], [200, 80]], text: { type: 'paragraph', children: [{ text: '冒烟矩形' }] } }
  ],
  viewport: { zoom: 1.5 }
}
const save = await postJson(`${API}/session/data`, { documentId: 'default', data: board })
assert.equal(save.status, 200)
const reloaded = await getJson(`${API}/session`)
assert.equal(reloaded.body.document.data.elements[0].text.children[0].text, '冒烟矩形')
assert.equal(reloaded.body.document.data.viewport.zoom, 1.5)
ok('自动保存链路：POST /session/data → 落盘 → 再读回内容一致')

const created = await postJson(`${API}/documents`, { action: 'create', name: '冒烟画板' })
assert.equal(created.status, 200)
const createdId = created.body.activeDocumentId
assert.equal(created.body.documents.length, 2)
assert.equal((await postJson(`${API}/documents`, { action: 'rename', id: createdId, name: '冒烟画板 v2' })).status, 200)
const duplicated = await postJson(`${API}/documents`, { action: 'duplicate', id: createdId })
assert.equal(duplicated.body.documents.length, 3)
assert.equal((await postJson(`${API}/documents`, { action: 'open', id: 'default' })).body.activeDocumentId, 'default')
const removed = await postJson(`${API}/documents`, { action: 'delete', id: createdId })
assert.equal(removed.body.documents.length, 2)
assert.equal((await postJson(`${API}/documents`, { action: 'delete', id: 'default' })).status, 400)
ok('文档管理：create / rename / duplicate / open / delete 全链路可用')

assert.equal((await postJson(`${API}/session/preferences`, { preference: { language: 'en' } })).status, 200)
assert.equal((await getJson(`${API}/session`)).body.preference.language, 'en')
ok('偏好设置：写入后随 /session 回读')

// 落盘检查：数据目录里必须真的出现画板文件。
const documentsDir = join(dataRoot, 'documents')
const documentFiles = readdirSync(documentsDir).filter((file) => file.endsWith('.json'))
assert.ok(documentFiles.length >= 1, '数据目录里应出现画板文件')
assert.ok(existsSync(join(dataRoot, 'state.json')), '数据目录里应出现 state.json')
ok(`数据目录落盘正常（${documentFiles.length} 个画板文件 + state.json）`)

if (checkDiskKeyword) {
  const all = documentFiles.map((file) => readFileSync(join(documentsDir, file), 'utf8')).join('\n')
  assert.ok(all.includes(checkDiskKeyword), `数据目录里没有找到关键字「${checkDiskKeyword}」`)
  ok(`数据目录里确实出现了关键字「${checkDiskKeyword}」（浏览器编辑已落盘）`)
}

console.log(`\n[smoke] 全部通过（${checks} 项）`)

if (keepServing) {
  console.log(`SMOKE_READY ${origin}${API}/app/index.html`)
  console.log('[smoke] 服务常驻中，按 Ctrl+C 结束。')
} else {
  server.close()
  if (!explicitRoot) rmSync(dataRoot, { recursive: true, force: true })
}
