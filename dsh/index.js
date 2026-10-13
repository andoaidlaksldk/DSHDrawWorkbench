/**
 * DSH 画板工作台 · 服务端入口。
 *
 * 职责只有两件事：
 *   1. 把 `app/` 下已经构建好的白板应用静态托管在本工作台自己的
 *      `/api/dsh-draw-workbench/app/` 路径前缀下。宿主渲染进程与 Harness
 *      WebServer 同源，因此工作台面板里的 iframe 属于同源文档，可以直接调用
 *      下面的文档接口，不需要额外的跨源协商或权限。
 *   2. 提供确定性的文档存取接口，让画板数据落在 DSH 数据目录
 *      （`cordis.patch.yml` 里的 `dshHomePath('draw-workbench')`）中，
 *      而不是只躺在浏览器的 IndexedDB 里。
 *
 * 磁盘上的文档就是一份 `.drawnix` 文件内容（`{ type, version, source,
 * elements, viewport }`），与白板应用「导出 / 打开文件」的格式完全一致：
 * 因此 Agent 工具写出来的画板可以直接导出给别人，外部 `.drawnix` 文件也能
 * 原样导入，不需要任何转换层。
 *
 * 静态路由在插件装载时按文件逐个注册：工作台的 fetch 路由按精确路径匹配，
 * 没有目录级通配，因此这里在装载期枚举 `app/` 并一一登记。
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-draw-workbench'
// 模块级声明依赖，apply 里直接使用 —— 与 @deepseek-ai/dsh-image-generation 完全相同
// 的写法。tools / systemPrompt 是 Harness 的核心服务：只有这样才能让注册出来的工具
// 真正进入会话的能力清单（用 ctx.inject(['tools'], …) 注册到子作用域是不够的）。
export const inject = ['connection', 'tools', 'systemPrompt']
export const Config = Schema.object({
  root: Schema.string().required()
})

const API = '/api/dsh-draw-workbench'
const APP_URL = `${API}/app`
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app')
// board_read 的返回会整段进入对话上下文，必须设上限（见工具实现）。
const MAX_BOARD_LINES = 300

const STATE_FILE = 'state.json'
const DOCUMENTS_DIR = 'documents'
const DEFAULT_DOCUMENT_ID = 'default'
const DOCUMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
// 白板会把插入的图片以 data URL 形式存进元素里，文件天生比思维导图大，
// 所以上限给得比导图工作台宽（那家是 8 MiB）。
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_NAME_LENGTH = 120

// 画板文件的顶层形状（与白板应用 packages/drawnix/src/data/types.ts 一致）。
const BOARD_TYPE = 'drawnix'
const BOARD_VERSION = 1

const MIME_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
}))

class WorkbenchError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export function contentTypeFor(file) {
  return MIME_TYPES.get(extname(file).toLowerCase()) || 'application/octet-stream'
}

function cacheControlFor(file) {
  const extension = extname(file).toLowerCase()
  // 入口页必须每次校验，其余构建产物带 query hash，但仍保持可校验以支持本地重建。
  if (extension === '.html' || extension === '.htm') return 'no-store'
  return 'no-cache'
}

/**
 * Harness 的精确 fetch 路由要求 `/api/` 之后的**每一段路径**都匹配
 * `ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/`（依据已安装应用内的 connection 实现）。
 *
 * 百分号编码、空格、非 ASCII 一律会被判为 `invalid exact Fetch route`。
 * 更严重的是：这个校验失败如果发生在**异步链**里，会升级成 unhandled rejection，
 * 进而 `dsh: fatal load failure` 打死整个 Harness（不是只让本插件失效）。
 * 因此登记前必须同步筛一遍：只登记合规路径，其余记录后跳过，绝不抛错。
 *
 * 白板的构建产物（Vite 输出）带内容哈希，但仍是纯 ASCII；`scripts/sync-app.mjs`
 * 还会在拷贝时把任何含非 ASCII 的文件名归一化，双重保险。
 */
const ROUTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

function isRegistrableAppPath(relative) {
  if (!relative || relative.startsWith('/') || relative.includes('\\')) return false
  return relative
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..' && ROUTE_SEGMENT_PATTERN.test(segment))
}

function collectFilesSync(directory, prefix = '') {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const collected = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) collected.push(...collectFilesSync(join(directory, entry.name), relative))
    else if (entry.isFile()) collected.push(relative)
  }
  return collected
}

async function collectFiles(directory, prefix = '') {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const collected = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) collected.push(...(await collectFiles(join(directory, entry.name), relative)))
    else if (entry.isFile()) collected.push(relative)
  }
  return collected
}

function staticRoute(relative) {
  const file = join(APP_ROOT, relative)
  // 路径必须原样使用：调用方已保证每段都合规（ASCII），不需要也不能做百分号编码。
  const path = `${APP_URL}/${relative}`
  return {
    path,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    async fetch(request) {
      let payload
      try {
        payload = await readFile(file)
      } catch {
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
      }
      const headers = {
        'content-type': contentTypeFor(relative),
        'cache-control': cacheControlFor(relative),
        'content-length': String(payload.byteLength)
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(payload, { status: 200, headers })
    }
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } catch (error) {
    // 写失败时不要把半截临时文件留在用户数据目录里。
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * 清理「上次进程被直接关掉」留下的临时文件。
 *
 * `writeJsonAtomic` 是「写临时文件 → 重命名」；正常路径下临时文件会被重命名掉，但
 * DSH Desktop 被强制关闭或断电时，写到一半的 `*.tmp-<pid>-<时间>` 会留在数据目录里
 * （同类工作台的数据目录里实测见到过 5 个残留）。启动时清掉**超过 10 分钟**的残留：
 * 既不会误删正在进行的写入，也不会让数据目录越积越多。
 */
const TEMPORARY_MAX_AGE = 10 * 60 * 1000

export async function sweepTemporaries(root) {
  for (const directory of [root, join(root, DOCUMENTS_DIR)]) {
    let entries = []
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue // 目录还不存在（首次启动）
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.tmp-\d+-\d+$/.test(entry.name)) continue
      const file = join(directory, entry.name)
      try {
        const info = await stat(file)
        if (Date.now() - info.mtimeMs < TEMPORARY_MAX_AGE) continue
        await unlink(file)
        console.log(`[dsh-draw-workbench] 已清理残留临时文件：${entry.name}`)
      } catch {
        // 清不掉（被占用等）不影响启动，下次再清。
      }
    }
  }
}

function documentFile(root, id) {
  return join(root, DOCUMENTS_DIR, `${id}.json`)
}

async function readBody(request) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new WorkbenchError('请求内容过大。', 413)
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new WorkbenchError('请求内容过大。', 413)
  if (!text) throw new WorkbenchError('请求需要 JSON 正文。')
  try {
    return JSON.parse(text)
  } catch {
    throw new WorkbenchError('请求正文不是合法 JSON。')
  }
}

function normalizeName(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) return fallback
  if (name.length > MAX_NAME_LENGTH) throw new WorkbenchError(`名称不能超过 ${MAX_NAME_LENGTH} 个字符。`)
  return name
}

function normalizeDocumentId(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_DOCUMENT_ID
  if (typeof value !== 'string' || !DOCUMENT_ID_PATTERN.test(value)) throw new WorkbenchError('文档标识不合法。')
  return value
}

/**
 * 归一化画板数据。白板应用有两套写法：
 *   - 导出 / 打开文件时用 `elements`（`.drawnix` 文件，也是本工作台落盘的格式）
 *   - 画布内存状态与 IndexedDB 里用 `children`
 * 两者都接受，落盘统一成 `.drawnix` 形态；`viewport` 缺失时补 `{ zoom: 1 }`
 * （白板项目校验只要求它是对象，打开时还会自己 fit 一次视口）。
 */
export function normalizeBoardData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkbenchError('画板数据必须是对象。')
  const elements = Array.isArray(value.elements)
    ? value.elements
    : (Array.isArray(value.children) ? value.children : null)
  if (!elements) throw new WorkbenchError('画板数据缺少 elements 数组。')
  const board = {
    type: BOARD_TYPE,
    version: Number.isFinite(value.version) ? value.version : BOARD_VERSION,
    source: typeof value.source === 'string' && value.source ? value.source : 'web',
    elements,
    viewport: value.viewport && typeof value.viewport === 'object' ? value.viewport : { zoom: 1 }
  }
  if (value.theme && typeof value.theme === 'object') board.theme = value.theme
  return board
}

function normalizeState(stored) {
  return {
    version: 1,
    activeDocumentId: normalizeDocumentId(stored?.activeDocumentId),
    preference: stored?.preference && typeof stored.preference === 'object' ? stored.preference : {}
  }
}

function readState(root) {
  return readJson(join(root, STATE_FILE)).then(normalizeState)
}

async function writeState(root, state) {
  const next = { ...normalizeState(state), updatedAt: new Date().toISOString() }
  await writeJsonAtomic(join(root, STATE_FILE), next)
  return next
}

function readDocument(root, id) {
  return readJson(documentFile(root, id))
}

async function writeDocument(root, document) {
  const next = { ...document, version: 1, updatedAt: new Date().toISOString() }
  await writeJsonAtomic(documentFile(root, document.id), next)
  return next
}

async function listDocuments(root) {
  const directory = join(root, DOCUMENTS_DIR)
  const files = await collectFiles(directory)
  const documents = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)
    if (!DOCUMENT_ID_PATTERN.test(id)) continue
    const stored = await readJson(join(directory, file))
    if (!stored || !stored.data) continue
    let size = 0
    try {
      size = (await stat(join(directory, file))).size
    } catch {
      size = 0
    }
    documents.push({
      id,
      name: typeof stored.name === 'string' && stored.name ? stored.name : id,
      createdAt: stored.createdAt || null,
      updatedAt: stored.updatedAt || null,
      elements: Array.isArray(stored.data?.elements) ? stored.data.elements.length : 0,
      size
    })
  }
  documents.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
  return documents
}

/** 空画板就够用：白板自己会在空画布上显示引导，比塞几个手写元素更可靠。 */
function exampleDocument(id, name) {
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
    data: {
      type: BOARD_TYPE,
      version: BOARD_VERSION,
      source: 'web',
      elements: [],
      viewport: { zoom: 1 }
    }
  }
}

function newDocumentId() {
  return `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 保证「默认文档」永远存在，并返回它与归一化后的状态。
 * 默认文档被删除或首次启动时都会在这里补齐；它不可被删除。
 */
async function ensureDefaultDocument(root) {
  const state = await readState(root)
  let document = await readDocument(root, state.activeDocumentId)
  if (!document) {
    if (state.activeDocumentId !== DEFAULT_DOCUMENT_ID) {
      state.activeDocumentId = DEFAULT_DOCUMENT_ID
      await writeState(root, state)
    }
    document = (await readDocument(root, DEFAULT_DOCUMENT_ID))
      || (await writeDocument(root, exampleDocument(DEFAULT_DOCUMENT_ID, '未命名画板')))
  }
  return { document, state }
}

function failure(error, fallback) {
  const message = error instanceof WorkbenchError ? error.message : fallback
  const status = error instanceof WorkbenchError ? error.status : 500
  return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } })
}

function json(value) {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function route(path, methods, fetch) {
  return { path: `${API}/${path}`, methods, requestBody: 'buffered', fetch }
}

// ====================================================== 画板 ⇄ 可读文本 ======
//
// 一个白板元素里的文字藏在三处完全不同的地方（几何/文本在 `text`，连线标签在
// `texts[]`，思维导图节点在 `data.topic`），逐个分支取出来是 board_read 与
// 元素统计的共同基础。

function paragraphText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map((child) => paragraphText(child)).join('')
  const children = Array.isArray(node.children) ? node.children : []
  return children.map((child) => (typeof child?.text === 'string' ? child.text : paragraphText(child))).join('')
}

export function elementText(element) {
  if (!element || typeof element !== 'object') return ''
  if (element.text) return paragraphText(element.text).trim()
  if (Array.isArray(element.texts)) {
    return element.texts.map((item) => paragraphText(item?.text).trim()).filter(Boolean).join(' / ')
  }
  if (element.data && element.data.topic) return paragraphText(element.data.topic).trim()
  return ''
}

function shapeRect(element) {
  const points = Array.isArray(element?.points) ? element.points : []
  if (points.length < 2) return null
  const [first, second] = points
  if (!Array.isArray(first) || !Array.isArray(second)) return null
  return {
    x1: Math.min(first[0], second[0]),
    y1: Math.min(first[1], second[1]),
    x2: Math.max(first[0], second[0]),
    y2: Math.max(first[1], second[1])
  }
}

function collectGeometries(elements, out = []) {
  for (const element of Array.isArray(elements) ? elements : []) {
    if (!element || typeof element !== 'object') continue
    if (element.type === 'geometry') out.push(element)
    if (Array.isArray(element.children)) collectGeometries(element.children, out)
  }
  return out
}

/**
 * 找出某个坐标落在哪个图形上（容差内直接命中，否则取最近的图形）。
 *
 * 由工具写出的连线是**绝对坐标、不做 boundId 绑定**的（绑定写错会让整条线不渲染），
 * 所以读回时只能靠坐标反查两端图形。没有这一步，board_read 对 Agent 画的图
 * 就只能输出「? → ?」，等于什么都没说。
 */
function shapeIdAt(point, geometries, tolerance = 24) {
  if (!Array.isArray(point)) return null
  let nearest = null
  let nearestDistance = Infinity
  for (const element of geometries) {
    const rect = shapeRect(element)
    if (!rect) continue
    if (point[0] >= rect.x1 - tolerance && point[0] <= rect.x2 + tolerance
      && point[1] >= rect.y1 - tolerance && point[1] <= rect.y2 + tolerance) {
      return element.id
    }
    const distance = Math.hypot(point[0] - (rect.x1 + rect.x2) / 2, point[1] - (rect.y1 + rect.y2) / 2)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = element.id
    }
  }
  return nearest
}

function elementKind(element) {
  const type = typeof element?.type === 'string' ? element.type : ''
  if (type === 'geometry') {
    if (element?.shape === 'text') return '文本'
    if (element?.shape === 'ellipse') return '椭圆'
    if (element?.shape === 'diamond') return '菱形'
    if (element?.shape === 'terminal') return '开始/结束'
    if (element?.shape === 'parallelogram') return '平行四边形'
    if (element?.shape === 'triangle') return '三角形'
    return '矩形'
  }
  if (type === 'arrow-line' || type === 'vector-line') return '连线'
  if (type === 'mind' || type === 'mindmap') return '思维导图'
  if (type === 'mind_child') return '导图节点'
  if (type === 'freehand') return '手绘'
  if (type === 'image') return '图片'
  return type || '元素'
}

/** 元素图（含思维导图的嵌套 children）→ 逐行文本，供 board_read 交给模型看。 */
export function boardToText(elements) {
  const lines = []
  const geometries = collectGeometries(elements)
  const nameOf = (id) => {
    const found = geometries.find((element) => element.id === id)
    return found ? (elementText(found) || id) : id
  }
  const walk = (list, depth) => {
    for (const element of Array.isArray(list) ? list : []) {
      if (!element || typeof element !== 'object') continue
      const indent = '  '.repeat(depth)
      const label = elementText(element)
      const kind = elementKind(element)
      if (element.type === 'arrow-line' || element.type === 'vector-line') {
        const points = Array.isArray(element.points) ? element.points : []
        const head = element?.source?.boundId || (points.length ? shapeIdAt(points[0], geometries) : null)
        const tail = element?.target?.boundId || (points.length ? shapeIdAt(points[points.length - 1], geometries) : null)
        const from = head ? nameOf(head) : '?'
        const to = tail ? nameOf(tail) : '?'
        lines.push(`${indent}- [连线] ${from} → ${to}${label ? `：${label}` : ''}`)
        continue
      }
      lines.push(`${indent}- [${kind}]${label ? ` ${label}` : ''}${element.id ? `（id=${element.id}）` : ''}`)
      if (Array.isArray(element.children) && element.children.length) walk(element.children, depth + 1)
    }
  }
  walk(elements, 0)
  return lines.join('\n')
}

function countElements(elements) {
  let total = 0
  const walk = (list) => {
    for (const element of Array.isArray(list) ? list : []) {
      if (!element || typeof element !== 'object') continue
      total += 1
      if (Array.isArray(element.children) && element.children.length) walk(element.children)
    }
  }
  walk(elements)
  return total
}

// ------------------------------------------------- 紧凑画板描述 → 元素 ------

const NODE_WIDTH = 200
const NODE_HEIGHT = 80
const COLUMN_GAP = 90
const ROW_GAP = 150
const SHAPE_ALIASES = new Map(Object.entries({
  rect: 'rectangle',
  rectangle: 'rectangle',
  round: 'roundRectangle',
  roundrect: 'roundRectangle',
  roundrectangle: 'roundRectangle',
  ellipse: 'ellipse',
  circle: 'ellipse',
  diamond: 'diamond',
  rhombus: 'diamond',
  parallelogram: 'parallelogram',
  triangle: 'triangle',
  // 白板的「开始/结束」形状（流程图里最常用的一种），常见叫法都收进来。
  terminal: 'terminal',
  pill: 'terminal',
  stadium: 'terminal',
  startend: 'terminal',
  '开始/结束': 'terminal',
  '开始结束': 'terminal',
  text: 'text'
}))

/** 供工具描述与报错提示共用的形状清单（与 SHAPE_ALIASES 的取值保持一致）。 */
const SHAPE_HINTS = 'rectangle, roundRectangle, ellipse, diamond, parallelogram, triangle, terminal, text'

function normalizeShape(value, fallback = 'roundRectangle') {
  if (typeof value !== 'string') return fallback
  return SHAPE_ALIASES.get(value.trim().toLowerCase()) || fallback
}

/**
 * 颜色：白板把样式存在元素上（`fill` / `strokeColor` / `strokeWidth`），
 * 字体颜色存在文本叶子上（`children[0].color`）。
 * 只接受 `#rgb` / `#rrggbb` / `#rrggbbaa`，避免把任意字符串写进用户数据里。
 */
const COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/

function normalizeColor(value) {
  if (typeof value !== 'string') return null
  const color = value.trim()
  return COLOR_PATTERN.test(color) ? color : null
}

function toNumber(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 把「紧凑画板描述」转成白板元素。
 *
 * 这是 board_write 的输入格式：模型只需要写节点与边，坐标可以不给——
 * 不给时按边的方向做一次分层布局（入度为 0 的节点是第一层，其余按其父层往下排），
 * 这样生成的流程图/结构图开箱就是排好的，不会叠在一起。
 *
 *   {
 *     "title": "上线流程",                       // 可选，画在左上角
 *     "nodes": [{ "id": "a", "text": "需求评审", "shape": "rectangle", "x": 0, "y": 0 }],
 *     "edges": [{ "from": "a", "to": "b", "label": "通过" }]
 *   }
 *
 * 另外也接受完整的 `.drawnix` 载荷（带 elements 数组）原样透传。
 */
export function boardSpecToElements(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new WorkbenchError('board 必须是 JSON 对象或字符串。')
  }
  if (Array.isArray(spec.elements)) {
    throw new WorkbenchError('board 里出现了 elements：请改用完整画板数据导入，或只写 nodes/edges。')
  }

  const rawNodes = Array.isArray(spec.nodes) ? spec.nodes.filter((node) => node && typeof node === 'object') : []
  if (!rawNodes.length) throw new WorkbenchError('board 至少需要一个 nodes 条目。')

  const nodes = rawNodes.map((node, index) => {
    const id = typeof node.id === 'string' && node.id.trim() ? node.id.trim() : `n${index + 1}`
    return {
      id,
      text: typeof node.text === 'string' ? node.text : (node.text === undefined || node.text === null ? '' : String(node.text)),
      shape: normalizeShape(node.shape),
      width: toNumber(node.width, NODE_WIDTH),
      height: toNumber(node.height, NODE_HEIGHT),
      x: node.x === undefined || node.x === null ? null : toNumber(node.x, 0),
      y: node.y === undefined || node.y === null ? null : toNumber(node.y, 0),
      fill: normalizeColor(node.fill),
      strokeColor: normalizeColor(node.strokeColor),
      strokeWidth: node.strokeWidth === undefined || node.strokeWidth === null ? null : toNumber(node.strokeWidth, null),
      fontColor: normalizeColor(node.fontColor)
    }
  })

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = (Array.isArray(spec.edges) ? spec.edges : [])
    .map((edge, index) => {
      const from = edge && typeof edge === 'object' ? edge.from : null
      const to = edge && typeof edge === 'object' ? edge.to : null
      if (typeof from !== 'string' || typeof to !== 'string') return null
      if (!byId.has(from) || !byId.has(to)) return null
      return {
        id: typeof edge.id === 'string' && edge.id ? edge.id : `e${index + 1}`,
        from,
        to,
        label: typeof edge.label === 'string' ? edge.label : ''
      }
    })
    .filter(Boolean)

  // 分层布局：只对「没给坐标」的节点生效（给了坐标的按给定的来）。
  const incoming = new Map(nodes.map((node) => [node.id, 0]))
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1)
  const level = new Map()
  const queue = nodes.filter((node) => (incoming.get(node.id) || 0) === 0).map((node) => node.id)
  if (!queue.length) queue.push(nodes[0].id)
  for (const id of queue) level.set(id, 0)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    for (const edge of edges.filter((item) => item.from === current)) {
      const next = (level.get(current) || 0) + 1
      if (level.has(edge.to)) {
        if ((level.get(edge.to) || 0) < next) level.set(edge.to, next)
      } else {
        level.set(edge.to, next)
        queue.push(edge.to)
      }
    }
  }
  // 被边指向但不在队列里的（环形图）也要有层号，避免落到第 0 层去撞车。
  for (const node of nodes) if (!level.has(node.id)) level.set(node.id, 1)

  const columns = new Map()
  for (const node of nodes) {
    const row = level.get(node.id) || 0
    const column = columns.get(row) || 0
    columns.set(row, column + 1)
    if (node.x === null) node.x = column * (node.width + COLUMN_GAP)
    if (node.y === null) node.y = row * (node.height + ROW_GAP)
  }

  const elements = []
  if (typeof spec.title === 'string' && spec.title.trim()) {
    const title = spec.title.trim()
    const titleColor = normalizeColor(spec.titleColor)
    elements.push({
      id: 'title',
      type: 'geometry',
      shape: 'text',
      points: [[0, -160], [Math.max(NODE_WIDTH, title.length * 22), -100]],
      text: { type: 'paragraph', children: [titleColor ? { text: title, color: titleColor } : { text: title }] }
    })
  }

  for (const node of nodes) {
    const element = {
      id: node.id,
      type: 'geometry',
      shape: node.shape,
      points: [[node.x, node.y], [node.x + node.width, node.y + node.height]]
    }
    if (node.fill) element.fill = node.fill
    if (node.strokeColor) element.strokeColor = node.strokeColor
    if (node.strokeWidth) element.strokeWidth = node.strokeWidth
    if (node.text || node.shape === 'text') {
      const leaf = node.fontColor ? { text: node.text || ' ', color: node.fontColor } : { text: node.text || ' ' }
      element.text = { type: 'paragraph', children: [leaf] }
    }
    if (node.shape === 'text') element.autoSize = true
    elements.push(element)
  }

  for (const edge of edges) {
    const source = byId.get(edge.from)
    const target = byId.get(edge.to)
    // 端点按两个图形的相对位置选边：横向为主时从左/右边出发，竖向为主时从上/下边出发。
    // 早期固定「下边中点 → 上边中点」，竖向流程没问题，但横向排布（如架构图、S 形流程）
    // 会把线画成绕来绕去的斜线。这里按主方向判断，两种布局都自然。
    const sourceCenter = [source.x + source.width / 2, source.y + source.height / 2]
    const targetCenter = [target.x + target.width / 2, target.y + target.height / 2]
    const deltaX = targetCenter[0] - sourceCenter[0]
    const deltaY = targetCenter[1] - sourceCenter[1]
    let from
    let to
    if (Math.abs(deltaX) >= Math.abs(deltaY)) {
      const forward = deltaX >= 0
      from = [forward ? source.x + source.width : source.x, sourceCenter[1]]
      to = [forward ? target.x : target.x + target.width, targetCenter[1]]
    } else {
      const forward = deltaY >= 0
      from = [sourceCenter[0], forward ? source.y + source.height : source.y]
      to = [targetCenter[0], forward ? target.y : target.y + target.height]
    }
    // 刻意不做 boundId 绑定：绑定需要同时给出正确的连接点语义，写错会让整条线不渲染。
    // 用绝对坐标画一条直箭头，任何情况下都能显示；代价是拖动图形时线不会跟着走。
    const element = {
      id: edge.id,
      type: 'arrow-line',
      shape: 'straight',
      points: [from, to],
      source: { marker: 'none' },
      target: { marker: 'arrow' },
      texts: [],
      opacity: 1
    }
    if (edge.label) element.texts = [{ text: { type: 'paragraph', children: [{ text: edge.label }] }, position: 0.5 }]
    elements.push(element)
  }

  return elements
}

/** 叠写模式：把新元素整体下移到已有内容下方，避免覆盖用户已经画好的东西。 */
function offsetElements(elements, offsetY) {
  return elements.map((element) => {
    const clone = { ...element }
    if (Array.isArray(clone.points)) clone.points = clone.points.map((point) => [point[0], point[1] + offsetY])
    if (Array.isArray(clone.texts)) clone.texts = clone.texts.map((item) => ({ ...item }))
    return clone
  })
}

function boardExtent(elements) {
  let maxY = 0
  for (const element of Array.isArray(elements) ? elements : []) {
    for (const point of Array.isArray(element?.points) ? element.points : []) {
      if (Array.isArray(point) && Number.isFinite(point[1])) maxY = Math.max(maxY, point[1])
    }
  }
  return maxY
}

export function apply(ctx, config) {
  const root = resolve(config.root)
  const hosted = { files: 0, skipped: [], rejected: [] }

  // 启动时清一次上次残留的临时文件。异步任务必须自带 catch：rejection 冒到异步链里
  // 会升级成 Harness 的 fatal load failure（本文件其它异步登记同理）。
  sweepTemporaries(root).catch(() => {})

  // 静态应用：**同步**枚举 `app/` 并逐文件登记精确路由。
  //
  // 三个必须遵守的约束（每一条都踩过）：
  //   1. 一个路径只能登记一次（Harness 的 fetch 路由表按 pathname 唯一，重复登记抛错）；
  //   2. 路径每一段必须匹配 `[A-Za-z0-9_$.-]`，否则判为 invalid exact Fetch route；
  //   3. 任何抛错都必须在插件自己的 effect 内发生 —— 抛在异步链里会变成
  //      unhandled rejection，最终 `dsh: fatal load failure` 打死整个 Harness。
  // 因此这里同步枚举、登记前校验、不合规/重复的路径只记录并跳过，绝不抛错。
  ctx.effect(() => {
    const disposers = []
    const registered = new Set()
    const register = (entry) => {
      if (registered.has(entry.path)) return false
      // 兜底：白名单已按段过滤，但路由表校验由宿主实现，规则可能比文档更严。
      // 思维导图工作台曾因这里抛出非法路由而在异步链里升级为 fatal load failure，
      // 直接把整台 Harness 打死——所以任何登记失败都只记录、不上抛。
      try {
        const dispose = ctx.connection.fetch.register(entry)
        registered.add(entry.path)
        if (typeof dispose === 'function') disposers.push(dispose)
        return true
      } catch (error) {
        const reason = (error && error.message) || String(error)
        hosted.rejected.push(`${entry.path}（${reason}）`)
        return false
      }
    }

    for (const file of collectFilesSync(APP_ROOT)) {
      if (!isRegistrableAppPath(file)) {
        hosted.skipped.push(file)
        continue
      }
      if (register(staticRoute(file))) hosted.files += 1
    }
    if (hosted.skipped.length) {
      // 跳到 stdout 便于在 harness.log 里定位；同时通过 /health 暴露给自检。
      console.warn(`[dsh-draw-workbench] 跳过 ${hosted.skipped.length} 个非法静态路径（需为 [A-Za-z0-9_$.-]）：${hosted.skipped.slice(0, 5).join('、')}`)
    }
    if (hosted.rejected.length) {
      console.warn(`[dsh-draw-workbench] 被宿主拒绝的静态路由 ${hosted.rejected.length} 条（已跳过，不影响其他路由）：${hosted.rejected.slice(0, 5).join('、')}`)
    }

    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
    }
  }, 'draw-workbench: static app routes')

  // 业务接口：同样登记在 effect 内，插件重载/卸载时才会撤销旧路由。
  ctx.effect(() => {
    const disposers = []
    const register = (entry) => {
      // 业务接口的路径都是本插件写死的 ASCII，但仍不上抛：装载期任何抛错都可能
      // 变成 fatal load failure，代价是整台 Harness 起不来。
      try {
        const dispose = ctx.connection.fetch.register(entry)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        console.warn(`[dsh-draw-workbench] 接口路由 ${entry.path} 登记失败：${(error && error.message) || error}`)
      }
    }

    register(route('health', ['GET'], async () => {
      let documents = 0
      try {
        documents = (await listDocuments(root)).length
      } catch {
        documents = 0
      }
      return json({
        ok: true,
        name,
        app: `${APP_URL}/index.html`,
        root,
        files: hosted.files,
        // 诊断用：被跳过的非法路径与被宿主拒绝的路由都要能从 /health 读到，
        // 否则「画布少了一部分」这类问题只能靠翻日志。
        skipped: hosted.skipped,
        rejected: hosted.rejected,
        documents
      })
    }))

    // 应用启动时读取当前文档与偏好设置。
    register(route('session', ['GET'], async () => {
      try {
        const { document, state } = await ensureDefaultDocument(root)
        return json({
          documentId: document.id,
          document: { id: document.id, name: document.name, data: document.data },
          preference: state.preference,
          updatedAt: document.updatedAt || null
        })
      } catch (error) {
        return failure(error, '无法读取画板数据。')
      }
    }))

    // 应用在画布变更后回写当前文档数据。
    register(route('session/data', ['POST'], async (request) => {
      try {
        const payload = await readBody(request)
        const id = normalizeDocumentId(payload.documentId)
        const data = normalizeBoardData(payload.data)
        const existing = await readDocument(root, id)
        // 只有 documents 接口与 board_write 能创建文档；这条路由只保存**已存在**的文档。
        // 若在这里兜底创建，删除文档的瞬间画布仍在自动保存（防抖 + 卸载时 sendBeacon），
        // 被删掉的文档会带着空数据复活——所以无条件要求文档已存在。
        if (!existing) throw new WorkbenchError('文档不存在。', 404)
        const document = await writeDocument(root, { ...existing, id, data })
        // 这里**不能**顺手把 activeDocumentId 改成 id：切换文档时，旧画布会在卸载阶段
        // 用 sendBeacon 把旧文档补写一次，若在此处抢 active，刚切过去的新文档会被立刻
        // 抢回旧文档（表现为「新建的画板打不开，永远打开第一个」）。
        // 谁是当前文档只由 documents 接口的显式动作（open/create/import/duplicate）决定。
        return json({ ok: true, documentId: id, updatedAt: document.updatedAt })
      } catch (error) {
        return failure(error, '无法保存画板数据。')
      }
    }))

    // 语言、复制/导出偏好等画布自己的设置。
    register(route('session/preferences', ['POST'], async (request) => {
      try {
        const payload = await readBody(request)
        const state = await readState(root)
        if (payload.preference !== undefined) {
          if (!payload.preference || typeof payload.preference !== 'object' || Array.isArray(payload.preference)) {
            throw new WorkbenchError('偏好设置必须是对象。')
          }
          state.preference = payload.preference
        }
        const next = await writeState(root, state)
        return json({ ok: true, updatedAt: next.updatedAt })
      } catch (error) {
        return failure(error, '无法保存偏好设置。')
      }
    }))

    // 文档接口：GET 读取列表，POST 执行 create / open / rename / duplicate / import / delete。
    // connection 的 fetch 路由按「精确路径」登记，同路径只能登记一次（不按方法区分），
    // 因此 GET 与 POST 必须合并为一条多方法路由，再按 request.method 分派。
    // 拆成两条 register 时，第二条会抛
    // `connection: exact Fetch route "/api/dsh-draw-workbench/documents" is already registered`。
    register(route('documents', ['GET', 'POST'], async (request) => {
      if (request?.method !== 'POST') {
        try {
          const { state } = await ensureDefaultDocument(root)
          return json({ documents: await listDocuments(root), activeDocumentId: state.activeDocumentId })
        } catch (error) {
          return failure(error, '无法读取文档列表。')
        }
      }

      try {
        const payload = await readBody(request)
        const action = payload.action
        const state = await readState(root)
        let activeDocumentId = state.activeDocumentId
        let document = null

        if (action === 'create') {
          const id = newDocumentId()
          document = await writeDocument(root, exampleDocument(id, normalizeName(payload.name, '未命名画板')))
          activeDocumentId = id
        } else if (action === 'import') {
          const id = newDocumentId()
          document = await writeDocument(root, {
            id,
            name: normalizeName(payload.name, '导入的画板'),
            createdAt: new Date().toISOString(),
            data: normalizeBoardData(payload.data)
          })
          activeDocumentId = id
        } else if (action === 'open') {
          const id = normalizeDocumentId(payload.id)
          document = await readDocument(root, id)
          if (!document) throw new WorkbenchError('文档不存在。', 404)
          activeDocumentId = id
        } else if (action === 'rename') {
          const id = normalizeDocumentId(payload.id)
          const existing = await readDocument(root, id)
          if (!existing) throw new WorkbenchError('文档不存在。', 404)
          document = await writeDocument(root, { ...existing, name: normalizeName(payload.name, existing.name) })
        } else if (action === 'duplicate') {
          const source = await readDocument(root, normalizeDocumentId(payload.id))
          if (!source) throw new WorkbenchError('文档不存在。', 404)
          const id = newDocumentId()
          document = await writeDocument(root, {
            id,
            name: normalizeName(payload.name, `${source.name} 副本`),
            createdAt: new Date().toISOString(),
            data: source.data
          })
          activeDocumentId = id
        } else if (action === 'delete') {
          const id = normalizeDocumentId(payload.id)
          if (id === DEFAULT_DOCUMENT_ID) throw new WorkbenchError('默认文档不可删除。')
          const existing = await readDocument(root, id)
          if (!existing) throw new WorkbenchError('文档不存在。', 404)
          // 先把「当前文档」移开，再删文件：反过来会给正在自动保存的画布留一个窗口，
          // 落在窗口里的保存请求会把刚删掉的文档写回来（删除后自动恢复的直接原因）。
          if (activeDocumentId === id) {
            activeDocumentId = DEFAULT_DOCUMENT_ID
            state.activeDocumentId = DEFAULT_DOCUMENT_ID
            await writeState(root, state)
          }
          await unlink(documentFile(root, id))
          document = (await ensureDefaultDocument(root)).document
        } else {
          throw new WorkbenchError('不支持的文档操作。')
        }

        if (state.activeDocumentId !== activeDocumentId) {
          state.activeDocumentId = activeDocumentId
          await writeState(root, state)
        }
        return json({
          ok: true,
          action,
          activeDocumentId,
          document: document ? { id: document.id, name: document.name, data: document.data } : null,
          documents: await listDocuments(root)
        })
      } catch (error) {
        return failure(error, '文档操作失败。')
      }
    }))

    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
    }
  }, 'draw-workbench: api routes')

  // -------------------------------------------------------- Agent 可调用工具 --
  //
  // 桌面会话里的 Agent 要能"用对话框把画板画出来"，就必须有可调用的接口——
  // 只注册客户端面板是不够的（面板是本插件自己的 UI，不在 Agent 的能力清单里）。
  // 这里把画板读写注册成 DSH 工具。
  //
  // 写法与 @deepseek-ai/dsh-image-generation 一致：模块级 inject 声明 tools /
  // systemPrompt，然后在 apply 里直接 ctx.tools.register(...)。
  // 早期版本写成 ctx.inject(['tools'], scope => scope.tools.register(...))：工具确实进了
  // 注册表（日志也打印了），但注册在子作用域里，**没进会话的能力清单**，所以对话框里调不到。
  registerBoardTools(ctx, defineTool, root)
  console.log('[dsh-draw-workbench] 已注册 Agent 工具：board_list / board_read / board_write')

  // 工具光存在还不够，模型得知道有这个能力、什么时机用。这一段进入系统提示，
  // 与 image-generation 的 `tool:image-generation` 同一机制。
  ctx.systemPrompt.section({
    name: 'tool:draw-workbench',
    order: 131,
    text: [
      'DSH whiteboard workbench: you can read and edit the user\'s whiteboards (画板 / 白板 / board).',
      'board_list lists the boards (and marks the one open on the canvas); board_read returns one board as a readable element list;',
      'board_write creates or overwrites a board from a compact JSON spec: {"title": optional, "nodes": [{"id","text","shape","x","y"}], "edges": [{"from","to","label"}]}.',
      'When the user asks to draw, sketch, lay out or reorganise something on a whiteboard / whiteboard diagram / 流程图 / 架构图 / 白板,',
      'call board_write with that JSON spec instead of only describing the structure in prose. Omit x/y and the tool lays the graph out by itself in layers.',
      'Prefer board_read for the board currently open in the workbench, and board_list when the target is unclear.',
      'The canvas notices external writes within a few seconds and offers 「重新载入」; tell the user to click it if the canvas looks stale.'
    ].join(' ')
  })
}

/** 把 `output` 声明成"一段文本"，避免对象 schema 的编译面。 */
function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  }
}

function coerceSpec(board) {
  if (typeof board === 'string') {
    const text = board.trim()
    if (!text) throw new WorkbenchError('board 不能为空。')
    try {
      return JSON.parse(text)
    } catch {
      throw new WorkbenchError('board 不是合法 JSON。')
    }
  }
  return board
}

/**
 * 注册三个画板工具。参数只使用字符串，输出是文本，
 * 这样既不触碰复杂 schema 方言，也恰好是模型最容易写对的形式。
 */
export function registerBoardTools(scope, defineTool, root) {
  const register = (tool) => scope.tools.register(tool)

  register(defineTool({
    name: 'board_list',
    description: 'List the whiteboard documents of the DSH whiteboard workbench (id, name, element count, last updated), and show which one is currently open on the canvas.',
    parameters: {},
    output: textOutput(),
    async execute() {
      const { state } = await ensureDefaultDocument(root)
      const documents = await listDocuments(root)
      const lines = documents.map((doc) => `- ${doc.name}（id=${doc.id}，${doc.elements} 个元素，更新于 ${doc.updatedAt || '未知'}）${doc.id === state.activeDocumentId ? ' ← 画布当前打开' : ''}`)
      return `共 ${documents.length} 个画板文档：\n${lines.join('\n')}`
    }
  }))

  register(defineTool({
    name: 'board_read',
    description: 'Read one whiteboard document as a readable list of its elements (shapes with their text, connectors as "source → target"). Omit documentId to read the document currently open on the canvas. Pass format="json" to get the raw .drawnix JSON instead (use that only when you need exact coordinates).',
    parameters: {
      documentId: { type: 'string', description: 'Document id from board_list. Omit to read the open document.' },
      format: { type: 'string', description: 'Omit (or "text") for the readable list; "json" for the raw .drawnix payload.' }
    },
    output: textOutput(),
    async execute(args) {
      const id = args?.documentId ? normalizeDocumentId(String(args.documentId)) : (await readState(root)).activeDocumentId
      const document = await readDocument(root, id)
      if (!document) throw new WorkbenchError(`文档不存在：${id}`, 404)
      const data = document.data || {}
      const elements = Array.isArray(data.elements) ? data.elements : []
      if (String(args?.format || '').toLowerCase() === 'json') {
        const raw = JSON.stringify({ ...data, elements: offsetElements(elements, 0) }, null, 2)
        return raw.length > 200000
          ? `${raw.slice(0, 200000)}\n…（画板过大已截断：共 ${countElements(elements)} 个元素）`
          : raw
      }
      const text = boardToText(elements)
      const allLines = text ? text.split('\n') : []
      // 工具结果会整段进入对话上下文：大画板必须截断，否则一次读取就能把上下文挤爆。
      const capped = allLines.length > MAX_BOARD_LINES
        ? `${allLines.slice(0, MAX_BOARD_LINES).join('\n')}\n…（另有 ${allLines.length - MAX_BOARD_LINES} 行未显示：画板过大，建议先只处理需要的部分）`
        : text
      return `文档：${document.name}（id=${document.id}，共 ${countElements(elements)} 个元素）\n\n${capped || '（空画板）'}`
    }
  }))

  register(defineTool({
    name: 'board_write',
    description: `Create or overwrite a whiteboard in the DSH whiteboard workbench from a compact JSON spec: {"title": optional string, "nodes": [{"id","text","shape","x","y","fill","strokeColor","strokeWidth","fontColor"}], "edges": [{"from","to","label"}]}. Omit x/y to let the tool lay the nodes out in layers. Supported shapes: ${SHAPE_HINTS}; an unknown shape falls back to a rounded rectangle. fill / strokeColor / fontColor take hex colors (for example "#6DC4C4"), which keeps diagrams readable; titleColor does the same for the title. This tool replaces a document as a whole (pass mode="append" to add the drawing below the existing content instead), so call board_read before changing an existing board. The canvas reloads to show the result.`,
    parameters: {
      board: { type: 'string', required: true, description: 'Compact JSON spec, or a full .drawnix payload (with an elements array).' },
      name: { type: 'string', description: 'Document name; defaults to the spec title or a generic name.' },
      documentId: { type: 'string', description: 'Write to this existing document id instead of creating a new one.' },
      mode: { type: 'string', description: 'Omit (or "replace") to replace the board; "append" adds the drawing below the existing elements.' }
    },
    output: textOutput(),
    async execute(args) {
      const spec = coerceSpec(args?.board)
      const append = String(args?.mode || '').toLowerCase() === 'append'
      const existing = args?.documentId ? await readDocument(root, normalizeDocumentId(String(args.documentId))) : null

      // 完整 .drawnix 载荷：原样归一化即可，不做节点转换。
      let data
      let created = 0
      if (spec && typeof spec === 'object' && Array.isArray(spec.elements)) {
        const incoming = normalizeBoardData(spec)
        if (append && existing) {
          const base = Array.isArray(existing.data?.elements) ? existing.data.elements : []
          const offset = boardExtent(base) + ROW_GAP
          data = { ...incoming, elements: base.concat(offsetElements(incoming.elements, offset)), viewport: existing.data?.viewport || incoming.viewport }
        } else {
          data = incoming
        }
        created = countElements(data.elements)
      } else {
        const elements = boardSpecToElements(spec)
        created = elements.length
        if (append && existing) {
          const base = Array.isArray(existing.data?.elements) ? existing.data.elements : []
          const offset = base.length ? boardExtent(base) + ROW_GAP : 0
          data = {
            ...(existing.data || {}),
            type: BOARD_TYPE,
            version: BOARD_VERSION,
            source: 'web',
            elements: base.concat(offsetElements(elements, offset)),
            viewport: existing.data?.viewport || { zoom: 1 }
          }
        } else {
          data = { type: BOARD_TYPE, version: BOARD_VERSION, source: 'web', elements, viewport: { zoom: 1 } }
        }
      }

      const requestedName = normalizeName(args?.name, '')
      const title = spec && typeof spec === 'object' && typeof spec.title === 'string' ? spec.title.trim() : ''
      const name = requestedName || existing?.name || title || '画板'
      const id = existing?.id || newDocumentId()
      const document = await writeDocument(root, {
        ...(existing || { id, name, createdAt: new Date().toISOString() }),
        id,
        name,
        data
      })
      const state = await readState(root)
      if (state.activeDocumentId !== id) {
        state.activeDocumentId = id
        await writeState(root, state)
      }
      return `已${existing ? (append ? '追加到' : '整体覆盖') : '新建'}画板「${document.name}」（id=${document.id}），写入 ${created} 个元素，画板共有 ${countElements(document.data.elements)} 个元素。`
        + (existing && !append ? '（原内容已被替换，不保留历史）' : '')
        + '\n画布会自动刷新；若未刷新，请点工具栏的「重新载入」。'
    }
  }))
}
