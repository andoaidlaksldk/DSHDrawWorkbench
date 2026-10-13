#!/usr/bin/env node
/**
 * DSHDrawWorkbench 上架截图脚本。
 *
 * 为什么要有这个脚本：市场规范要求截图**取自最终可安装版本的真实界面**、由作者维护。
 * 这里用插件自己的服务端把 `app/`（随包分发的同一份构建产物）托管起来，用浏览器
 * 按 1600×900 实拍；画板内容由 `boardSpecToElements` 生成，全是演示图形，不含真实数据。
 *
 * 两个实现要点（都是实测踩出来的）：
 *   1. 不用 `chrome --screenshot`：白板是会持续重绘的画布应用，`--virtual-time-budget`
 *      等不到「渲染器空闲」，会一直挂着不产出图片。这里自己连 CDP：等 load → 等画布挂载
 *      → 再等一段时间让首帧画完 → 截图。
 *   2. 构图靠自己算视口：白板在没有 `origination` 时会把内容居中，但不会自动缩放，
 *      竖向流程会被裁掉。这里按内容包围盒算 `zoom` 与 `origination`，保证整图完整入画。
 *
 * 用法：
 *   node scripts/capture-screenshots.mjs --browser "<chrome.exe>"
 *   node scripts/capture-screenshots.mjs --browser "<msedge.exe>" --out docs/screenshots --port 7391
 *
 * 产出：<out>/overview.png（封面，流程图）、<out>/architecture.png（分层架构）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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

const browser = arg('--browser', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
const outDir = resolve(root, arg('--out', 'docs/screenshots'))
const serverPort = Number(arg('--port', 7391))
const width = Number(arg('--width', 1600))
const height = Number(arg('--height', 900))

if (!existsSync(browser)) {
  console.error(`[shots] 找不到浏览器：${browser}\n       用 --browser "<可执行文件路径>" 指定 Chrome / Edge。`)
  process.exit(1)
}

// 演示配色取白板自带色板里的颜色，保持与产品原生风格一致。
const TEAL = '#6DC4C4'
const BLUE = '#6E80DB'
const INDIGO = '#4E49BE'
const AMBER = '#E0B75E'
const GREEN = '#77C386'
const RED = '#E48484'
const PURPLE = '#8957E5'
const WHITE = '#FFFFFF'

/**
 * 两块演示画板：全部是示意图，不含任何真实业务数据。
 * 节点尺寸与间距是刻意排过的——白板字号固定，构图饱满、留白均衡才显得利落。
 */
const SHOTS = [
  {
    file: 'overview.png',
    name: '上线流程',
    theme: 'default',
    board: {
      title: '上线流程',
      titleColor: INDIGO,
      // 三行「蛇形」走向：第一行向左→右，第二行右→左，第三行再向左→右；
      // 相邻两行之间用竖向箭头衔接，所以既铺得开、也不会出现交叉线。
      nodes: [
        { id: 'r1', text: '需求评审', shape: 'roundRect', x: 0, y: 0, width: 200, height: 76, fill: TEAL, fontColor: WHITE },
        { id: 'r2', text: '方案设计', shape: 'roundRect', x: 340, y: 0, width: 200, height: 76, fill: BLUE, fontColor: WHITE },
        { id: 'r3', text: '开发实现', shape: 'roundRect', x: 680, y: 0, width: 200, height: 76, fill: INDIGO, fontColor: WHITE },
        { id: 'r4', text: '代码评审', shape: 'roundRect', x: 1020, y: 0, width: 200, height: 76, fill: PURPLE, fontColor: WHITE },
        { id: 'r5', text: '测试验收', shape: 'diamond', x: 1020, y: 194, width: 200, height: 88, fill: AMBER, fontColor: WHITE },
        { id: 'r6', text: '灰度发布', shape: 'roundRect', x: 680, y: 200, width: 200, height: 76, fill: GREEN, fontColor: WHITE },
        { id: 'r7', text: '灰度观测', shape: 'roundRect', x: 340, y: 200, width: 200, height: 76, fill: TEAL, fontColor: WHITE },
        { id: 'r8', text: '上线完成', shape: 'terminal', x: 0, y: 200, width: 200, height: 76, fill: PURPLE, fontColor: WHITE },
        { id: 'r9', text: '归档复盘', shape: 'roundRect', x: 0, y: 400, width: 200, height: 76, fill: BLUE, fontColor: WHITE },
        { id: 'r10', text: '监控告警', shape: 'roundRect', x: 340, y: 400, width: 200, height: 76, fill: GREEN, fontColor: WHITE },
        { id: 'r11', text: '迭代规划', shape: 'roundRect', x: 680, y: 400, width: 200, height: 76, fill: AMBER, fontColor: WHITE },
        { id: 'r12', text: '下一版本', shape: 'terminal', x: 1020, y: 400, width: 200, height: 76, fill: RED, fontColor: WHITE }
      ],
      edges: [
        { from: 'r1', to: 'r2', label: '通过' },
        { from: 'r2', to: 'r3' },
        { from: 'r3', to: 'r4' },
        { from: 'r4', to: 'r5', label: '提测' },
        { from: 'r5', to: 'r6', label: '通过' },
        { from: 'r6', to: 'r7', label: '观察' },
        { from: 'r7', to: 'r8' },
        { from: 'r8', to: 'r9', label: '归档' },
        { from: 'r9', to: 'r10' },
        { from: 'r10', to: 'r11' },
        { from: 'r11', to: 'r12', label: '排期' }
      ]
    }
  },
  {
    file: 'architecture.png',
    name: '系统架构',
    theme: 'dark',
    board: {
      title: '系统架构（示意）',
      titleColor: TEAL,
      nodes: [
        { id: 'client', text: '桌面客户端', shape: 'roundRect', x: 510, y: 0, width: 200, height: 76, fill: BLUE, fontColor: WHITE },
        { id: 'gateway', text: '接入网关', shape: 'rectangle', x: 510, y: 200, width: 200, height: 76, fill: INDIGO, fontColor: WHITE },
        { id: 'session', text: '会话服务', shape: 'roundRect', x: 0, y: 400, width: 200, height: 76, fill: TEAL, fontColor: WHITE },
        { id: 'board', text: '画板服务', shape: 'roundRect', x: 1020, y: 400, width: 200, height: 76, fill: GREEN, fontColor: WHITE },
        { id: 'store', text: '数据目录', shape: 'ellipse', x: 510, y: 600, width: 200, height: 76, fill: AMBER, fontColor: WHITE }
      ],
      edges: [
        { from: 'client', to: 'gateway' },
        { from: 'gateway', to: 'session', label: '会话' },
        { from: 'gateway', to: 'board', label: '画板' },
        { from: 'session', to: 'store' },
        { from: 'board', to: 'store' }
      ]
    }
  }
]

// ------------------------------------------------------------------ 起服务 --
const serverModule = await import(pathToFileURL(join(root, 'dsh', 'index.js')).href)
const { apply, boardSpecToElements, normalizeBoardData } = serverModule
const routes = []
const ctx = {
  connection: {
    fetch: {
      register(route) {
        if (routes.some((item) => item.path === route.path)) throw new Error(`duplicate route ${route.path}`)
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

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-draw-shots-'))
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
  const forwarded = new Request(`http://127.0.0.1${request.url}`, {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.concat(chunks)
  })
  try {
    const result = await route.fetch(forwarded)
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error))
  }
})
await new Promise((done) => server.listen(serverPort, '127.0.0.1', done))
const origin = `http://127.0.0.1:${serverPort}`
console.log(`[shots] 服务已起：${origin}${API}/app/index.html`)

const post = async (path, value) => {
  const response = await fetch(`${origin}${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value)
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

/**
 * 按内容包围盒算视口：白板自己只会在没有 `origination` 时居中、但不会缩放，
 * 内容一高就会被裁。这里让整张图带边距完整入画（`origination` = 视口左上角对应的画布坐标）。
 */
function fitViewport(elements, viewWidth, viewHeight, padding = 90) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const element of elements) {
    const points = Array.isArray(element.points) ? element.points : []
    if (points.length < 2) continue
    minX = Math.min(minX, points[0][0])
    minY = Math.min(minY, points[0][1])
    maxX = Math.max(maxX, points[1][0])
    maxY = Math.max(maxY, points[1][1])
  }
  if (!Number.isFinite(minX)) return { zoom: 1 }
  const contentWidth = Math.max(1, maxX - minX)
  const contentHeight = Math.max(1, maxY - minY)
  const zoom = Math.min(1, (viewWidth - padding * 2) / contentWidth, (viewHeight - padding * 2) / contentHeight)
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  return {
    zoom: Number(zoom.toFixed(3)),
    origination: [Math.round(centerX - viewWidth / 2 / zoom), Math.round(centerY - viewHeight / 2 / zoom)]
  }
}

await post('/session/preferences', { preference: { language: 'zh' } })
mkdirSync(outDir, { recursive: true })

const boards = []
for (const shot of SHOTS) {
  const response = await post('/documents', { action: 'create', name: shot.name })
  const id = response.body?.activeDocumentId
  if (!id) throw new Error(`创建演示画板失败：${JSON.stringify(response)}`)
  const elements = boardSpecToElements(shot.board)
  const viewport = fitViewport(elements, width, height)
  const data = normalizeBoardData({
    type: 'drawnix',
    version: 1,
    source: 'web',
    elements,
    viewport,
    // 主题是白板自带能力（默认 / 缤纷 / 柔和 / 复古 / 暗夜 / 星空）。
    theme: { themeColorMode: shot.theme }
  })
  const saved = await post('/session/data', { documentId: id, data })
  if (saved.status !== 200) throw new Error(`写入演示画板失败：${JSON.stringify(saved)}`)
  boards.push({ ...shot, id })
  console.log(`[shots] 演示画板「${shot.name}」已写入（${elements.length} 个元素，zoom=${viewport.zoom}，origination=[${viewport.origination}]）`)
}

// ------------------------------------------------------------------ CDP --
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitForDevTools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  throw new Error('浏览器 DevTools 端口没有就绪')
}

class Session {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.opened = new Promise((done, fail) => {
      this.socket.addEventListener('open', () => done())
      this.socket.addEventListener('error', () => fail(new Error('CDP 连接失败')))
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { done, fail } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) fail(new Error(message.error.message))
        else done(message.result)
        return
      }
      for (const waiter of (this.listeners.get(message.method) || []).splice(0)) waiter(message.params)
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        fail(new Error(`CDP ${method} 超时`))
      }, 30000)
    })
  }

  once(method, timeoutMs = 30000) {
    return new Promise((done, fail) => {
      const waiters = this.listeners.get(method) || []
      waiters.push(done)
      this.listeners.set(method, waiters)
      setTimeout(() => fail(new Error(`等待事件 ${method} 超时`)), timeoutMs)
    })
  }

  close() {
    try { this.socket.close() } catch { /* 已关闭 */ }
  }
}

async function shoot(shots) {
  const cdpPort = 9300 + Math.floor(Math.random() * 400)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-draw-cdp-'))
  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${cdpPort}`,
    'about:blank'
  ], { stdio: 'ignore' })

  const results = []
  try {
    await waitForDevTools(cdpPort)
    for (const shot of shots) {
      // 靠服务端的 activeDocumentId 切换画板：画布启动时会去 /session 取当前文档。
      await post('/documents', { action: 'open', id: shot.id })
      const targetUrl = `${origin}${API}/app/index.html`
      const created = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' })
      const target = await created.json()
      const session = new Session(target.webSocketDebuggerUrl)
      await session.opened
      try {
        await session.send('Page.enable')
        await session.send('Runtime.enable')
        await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        const loaded = session.once('Page.loadEventFired')
        await session.send('Page.navigate', { url: targetUrl })
        await loaded

        // 等画布真正挂上并画出首帧（白板持续重绘，不能靠「渲染器空闲」判断）。
        const deadline = Date.now() + 20000
        let ready = false
        while (Date.now() < deadline) {
          const probe = await session.send('Runtime.evaluate', {
            expression: 'Boolean(document.querySelector(".plait-board-attached"))',
            returnByValue: true
          })
          if (probe?.result?.value === true) { ready = true; break }
          await sleep(300)
        }
        if (!ready) throw new Error(`画板没有渲染出来：${shot.file}`)
        await sleep(2500)

        const shotResult = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        const output = join(outDir, shot.file)
        writeFileSync(output, Buffer.from(shotResult.data, 'base64'))
        const bytes = readFileSync(output)
        const imageWidth = bytes.readUInt32BE(16)
        const imageHeight = bytes.readUInt32BE(20)
        results.push({ ...shot, bytes: bytes.length, width: imageWidth, height: imageHeight })
        console.log(`[shots] ${shot.file} ←「${shot.name}」 ${imageWidth}×${imageHeight}  ${(bytes.length / 1024).toFixed(0)} KB`)
      } finally {
        session.close()
        await fetch(`http://127.0.0.1:${cdpPort}/json/close/${target.id}`).catch(() => {})
      }
    }
  } finally {
    child.kill()
    await sleep(1500)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      // Windows 上 Chrome 退出后可能还占着一两个文件；临时目录留给系统清理即可。
    }
  }
  return results
}

const results = await shoot(boards)

server.close()
try {
  rmSync(dataRoot, { recursive: true, force: true })
} catch {
  /* 同上 */
}

console.log('\n[shots] 完成：')
for (const item of results) {
  const megabytes = item.bytes / 1024 / 1024
  console.log(`  ${item.file}  ${item.width}×${item.height}  ${megabytes.toFixed(2)} MiB${megabytes > 2 ? '  ⚠ 超过市场要求的 2 MiB' : ''}`)
}
console.log(`  输出目录：${outDir}`)
