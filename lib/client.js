/**
 * DSH 画板工作台 · 客户端入口（已构建的单文件模块）。
 *
 * 加载协议：window.__ModuleLoader__.load({ id, factory })，与仓库内其他插件一致。
 * 职责划分：
 *   - 样式        installStyles()
 *   - 文案        ctx.locale.register(NS, { zh, en })
 *   - 接口调用    callApi()（集中在工作台请求函数里，不散落在展示组件中）
 *   - 桥接协议    CHANNEL / postMessage（与 overlay/app.tsx 对称）
 *   - 界面        工具栏 + 画布（内嵌白板）+ 可收起的会话停靠区
 *
 * 关于内嵌方式：工作台规范要求业务面板是一个 React 组件，宿主不提供 iframe
 * 容器、也禁止 <webview>；而被内嵌的白板（drawnix）是一个独立的 React + Vite
 * 应用。为了完整保留它的全部绘图能力（图形、连线、思维导图、手绘、导入导出），
 * 这里不重写业务代码，而是把它构建好的产物托管在自己的同源路由下、用 iframe 承载，
 * 并通过 postMessage 把「打开哪块画板 / 现在存到哪」交给工作台。
 * 画布与 DSH 渲染进程同源，因此不需要任何跨源豁免或额外权限。
 */
window.__ModuleLoader__.load({
  id: 'dsh-draw-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-draw-workbench'
    const API = '/api/dsh-draw-workbench'
    const APP_URL = `${API}/app/index.html`
    const CHANNEL = 'dsh-draw-workbench'
    const REPOSITORY = 'https://github.com/andoaidlaksldk/DSHDrawWorkbench'
    const SNAPSHOT_TIMEOUT_MS = 5000
    const FIRST_USE_HINT_KEY = 'dsh-draw-workbench.first-use-hint.v1'
    // 轮询文档列表以发现「画布之外的写入」（例如 Agent 调用 board_write）。
    // 只提示、不自动重载：自动重载会在画布自己保存的瞬间误判并丢掉用户正在编辑的内容。
    const EXTERNAL_POLL_MS = 4000

    // ---------------------------------------------------------------- 样式 ----

    const css = `
.dshDw{position:relative;display:flex;flex-direction:column;flex:1 1 auto;width:100%;height:100%;min-width:0;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshDwToolbar{box-sizing:border-box;display:flex;align-items:center;gap:8px;flex:0 0 auto;min-height:48px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);overflow:hidden}
.dshDwBrand{display:flex;align-items:center;gap:8px;flex:0 0 auto;font-size:14px;line-height:22px;font-weight:600;white-space:nowrap}
.dshDwBrandMark{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:var(--dsw-alias-state-business-primary);color:#fff;font-size:12px;font-weight:700}
.dshDwGroup{display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0}
.dshDwSpacer{flex:1 1 auto;min-width:4px}
.dshDwSelect{max-width:min(260px,34vw);min-width:96px;padding:5px 8px;font:inherit;font-size:12px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);box-sizing:border-box}
.dshDwSelect:focus-visible,.dshDwBtn:focus-visible,.dshDwInput:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshDwBtn{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;font:inherit;font-size:12px;line-height:20px;white-space:nowrap;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);box-sizing:border-box}
.dshDwBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshDwBtn:disabled{cursor:default;opacity:.5}
.dshDwBtn[data-variant=primary]{color:#fff;background:var(--dsw-alias-state-business-primary);border-color:transparent}
.dshDwBtn[data-variant=primary]:hover:not(:disabled){filter:brightness(1.06)}
.dshDwBtn[data-variant=ghost]{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.dshDwBtn[data-variant=ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshDwBtn[data-variant=danger]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent)}
.dshDwStatus{display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;padding:0 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshDwStatus[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dshDwDot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dshDwDot[data-state=ready]{background:var(--dsw-alias-state-business-primary)}
.dshDwDot[data-state=saving]{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
.dshDwDot[data-state=offline]{background:var(--dsw-alias-state-error-primary)}
.dshDwWarn{flex:0 0 auto;padding:7px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 26%,transparent)}
.dshDwBody{display:flex;flex:1 1 auto;min-width:0;min-height:0}
.dshDwCanvas{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex}
.dshDwFrameWrap{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex;background:var(--dsw-alias-bg-module-platform)}
.dshDwFrame{flex:1 1 auto;width:100%;height:100%;min-width:0;min-height:0;border:0;display:block;background:#fff}
.dshDwOverlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.dshDwOverlay strong{font-size:14px;color:var(--dsw-alias-label-primary)}
.dshDwDock{flex:0 0 auto;display:flex;flex-direction:column;width:min(400px,40%);min-width:260px;min-height:0;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshDwDockFill{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0}
.dshDwHint[hidden],.dshDwDock[hidden]{display:none!important}
.dshDwSession{display:flex;flex-direction:column;gap:12px;padding:18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow:auto}
.dshDwSession h2{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dshDwSession p{margin:0}
.dshDwSessionRow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dshDwHint{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:6px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l2)}
.dshDwHint span:first-child{flex:1 1 auto;min-width:0}
.dshDwModalBackdrop{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:20px;background:color-mix(in srgb,#000 42%,transparent)}
.dshDwModal{width:min(420px,100%);box-sizing:border-box;padding:20px;border-radius:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 18px 52px rgba(0,0,0,.24);display:flex;flex-direction:column;gap:12px}
.dshDwModal h2{margin:0;font-size:15px;line-height:24px}
.dshDwModal p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshDwInput{width:100%;box-sizing:border-box;padding:8px 10px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dshDwModalActions{display:flex;justify-content:flex-end;gap:8px}
.dshDwHidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:900px){.dshDwDock{width:100%;min-width:0;border-left:0;border-top:1px solid var(--dsw-alias-border-l2);max-height:42%}.dshDwBody{flex-direction:column}.dshDwSelect{max-width:auto}}
@media(prefers-reduced-motion:reduce){.dshDwBtn,.dshDwSelect{transition:none}}
`

    function installStyles() {
      const existing = document.querySelector('style[data-plugin-css="dsh-draw-workbench"]')
      if (existing) {
        if (existing.textContent !== css) existing.textContent = css
        return
      }
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-draw-workbench'
      style.dataset.pluginCss = 'dsh-draw-workbench'
      style.textContent = css
      document.head.appendChild(style)
    }

    // ---------------------------------------------------------------- 文案 ----

    const zh = {
      title: 'DSH 画板',
      panelTitle: '画板工作台',
      description: '在工作台里画流程图、架构图、思维导图与手绘草图；文档保存在 DSH 数据目录，可与会话并行使用。',
      category: '效率',
      document: '画板',
      newDocument: '新建画板',
      openDocument: '打开',
      rename: '重命名',
      duplicate: '创建副本',
      remove: '删除',
      importDocument: '导入文件',
      exportDocument: '导出文件',
      saveNow: '立即保存',
      reload: '重新载入',
      session: 'AI 协助',
      aiAssist: 'AI 协助',
      aiAssistOn: '收起 AI 协助',
      statusLoading: '正在载入…',
      statusReady: '已连接画板',
      statusSaving: '正在保存…',
      statusSaved: '已保存',
      statusOffline: '离线：无法读写 DSH 数据目录，画板改动不会保存',
      bootError: '画板应用未能载入。',
      serverMissing: '服务端插件未加载：请在 DSH Desktop 菜单中选择「重启 Harness」，然后点重试。',
      retry: '重试',
      createTitle: '新建画板',
      createLabel: '名称',
      createConfirm: '创建',
      renameTitle: '重命名画板',
      renameConfirm: '保存',
      deleteTitle: '删除画板',
      deleteBody: '删除后无法恢复。文档文件会从 DSH 数据目录中移除。',
      deleteConfirm: '删除',
      cancel: '取消',
      busy: '处理中…',
      dialogRequired: '名称不能为空。',
      sessionSetupTitle: 'AI 协助',
      sessionSetupBody: '画板不依赖会话，绘图、导入导出都可直接使用。想让 Agent 把图画到画板上（例如「画一张上线流程图」）时，先创建一个关联本工作台的会话。',
      workspaceLabel: '工作区',
      newWorkspaceSession: '选择资料位置并开始会话',
      useWorkspace: '在此工作区开始会话',
      noWorkspace: '还没有可用工作区，请先选择资料位置新建一个。',
      firstUseHint: '画板本身不需要会话；想让 Agent 直接画到画板上时点右上角「AI 协助」。',
      externalUpdate: '当前画板已被外部更新（例如 Agent 写入）。',
      dismiss: '不再提示',
      noDocuments: '还没有画板',
      exportFailed: '导出失败：画板没有响应。',
      importInvalid: '导入失败：文件不是合法的画板文件（需要 .drawnix 或含 elements 的 JSON）。',
      defaultName: '未命名画板'
    }

    const en = {
      title: 'DSH Draw Workbench',
      panelTitle: 'Whiteboard workbench',
      description: 'Sketch flowcharts, architecture diagrams, mind maps and freehand drawings; boards are stored in the DSH data directory.',
      category: 'Productivity',
      document: 'Board',
      newDocument: 'New board',
      openDocument: 'Open',
      rename: 'Rename',
      duplicate: 'Duplicate',
      remove: 'Delete',
      importDocument: 'Import file',
      exportDocument: 'Export file',
      saveNow: 'Save now',
      reload: 'Reload canvas',
      session: 'AI assistance',
      aiAssist: 'AI assistance',
      aiAssistOn: 'Hide AI assistance',
      statusLoading: 'Loading…',
      statusReady: 'Canvas connected',
      statusSaving: 'Saving…',
      statusSaved: 'Saved',
      statusOffline: 'Offline: cannot read or write the DSH data directory; changes are not saved',
      bootError: 'The whiteboard application could not be loaded.',
      serverMissing: 'The server-side plugin is not loaded. Choose “Restart Harness” in the DSH Desktop menu, then retry.',
      retry: 'Retry',
      createTitle: 'New board',
      createLabel: 'Name',
      createConfirm: 'Create',
      renameTitle: 'Rename board',
      renameConfirm: 'Save',
      deleteTitle: 'Delete board',
      deleteBody: 'This cannot be undone. The document file is removed from the DSH data directory.',
      deleteConfirm: 'Delete',
      cancel: 'Cancel',
      busy: 'Working…',
      dialogRequired: 'A name is required.',
      sessionSetupTitle: 'AI assistance',
      sessionSetupBody: 'Boards do not need a conversation — drawing, import and export all work on their own. To have the agent draw onto the board (for example “draw a release flow”), start a conversation bound to this workbench first.',
      workspaceLabel: 'Workspace',
      newWorkspaceSession: 'Choose a folder and start a conversation',
      useWorkspace: 'Start a conversation in this workspace',
      noWorkspace: 'No workspace yet — choose a folder location first.',
      firstUseHint: 'Boards need no conversation; use “AI assistance” (top right) to have the agent draw onto the board.',
      externalUpdate: 'This board was updated outside the canvas (for example by the agent).',
      dismiss: 'Don’t show again',
      noDocuments: 'No boards yet',
      exportFailed: 'Export failed: the canvas did not respond.',
      importInvalid: 'Import failed: not a valid board file (expected .drawnix or JSON with an elements array).',
      defaultName: 'Untitled board'
    }

    // ---------------------------------------------------------------- 接口 ----

    async function callApi(path, init) {
      const response = await fetch(`${API}/${path}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init
      })
      const contentType = response.headers.get('content-type') || ''
      const payload = contentType.includes('application/json')
        ? await response.json().catch(() => null)
        : null
      if (!response.ok) {
        const error = new Error((payload && payload.error) || `HTTP ${response.status}`)
        // 404 表示本插件的服务端路由没挂上（最常见原因：装好工作台后没有重启 Harness）。
        // 保留状态码，让界面给出可操作的提示，而不是只显示 HTTP 404。
        error.status = response.status
        throw error
      }
      return payload
    }

    const readDocuments = () => callApi('documents')
    const writeDocuments = (body) => callApi('documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

    /** 404 说明本插件的服务端路由没挂上（最常见原因：装好工作台后没重启 Harness）。 */
    function describeApiError(t, error) {
      if (error && error.status === 404) return t('serverMissing')
      return (error && error.message) || String(error)
    }

    function downloadJson(fileName, value) {
      const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }

    function formatClock(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleTimeString()
    }

    // ---------------------------------------------------------------- 对话框 ----

    function Dialog({ title, description, label, initialValue, confirmText, cancelText, tone, busy, onConfirm, onCancel }) {
      const [value, setValue] = React.useState(initialValue || '')
      const [error, setError] = React.useState('')
      const inputRef = React.useRef(null)
      const dialogRef = React.useRef(null)

      React.useEffect(() => {
        if (inputRef.current) inputRef.current.focus()
        else dialogRef.current?.focus()
      }, [])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation()
            onCancel()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [busy, onCancel])

      const submit = (event) => {
        event.preventDefault()
        if (busy) return
        if (label && !value.trim()) {
          setError('required')
          return
        }
        setError('')
        onConfirm(label ? value.trim() : undefined)
      }

      return h('div', {
        className: 'dshDwModalBackdrop',
        onClick: (event) => { if (event.target === event.currentTarget && !busy) onCancel() }
      },
      h('div', {
        className: 'dshDwModal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        tabIndex: -1,
        ref: dialogRef
      },
      h('form', { onSubmit: submit, style: { display: 'contents' } },
        h('h2', null, title),
        description ? h('p', null, description) : null,
        label ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' } },
          h('span', null, label),
          h('input', {
            className: 'dshDwInput',
            ref: inputRef,
            value,
            maxLength: 120,
            disabled: busy,
            'aria-invalid': error ? 'true' : undefined,
            onChange: (event) => setValue(event.target.value)
          })
        ) : null,
        error ? h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } }, 'required') : null,
        h('div', { className: 'dshDwModalActions' },
          h('button', { type: 'button', className: 'dshDwBtn', disabled: busy, onClick: onCancel }, cancelText),
          h('button', {
            type: 'submit',
            className: 'dshDwBtn',
            'data-variant': tone === 'danger' ? 'danger' : 'primary',
            disabled: busy
          }, confirmText)
        )
      ))
      )
    }

    // ------------------------------------------------------------ 工作台面板 ----

    function createPanel(t) {
      return function DrawWorkbenchPanel({ service, entry, active, conversation }) {
        const [status, setStatus] = React.useState('loading')
        const [errorText, setErrorText] = React.useState('')
        const [notice, setNotice] = React.useState('')
        const [documents, setDocuments] = React.useState([])
        const [activeDocumentId, setActiveDocumentId] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [dialog, setDialog] = React.useState(null)
        const [reloadToken, setReloadToken] = React.useState(0)
        const [dirty, setDirty] = React.useState(false)
        const [savedAt, setSavedAt] = React.useState('')
        const [offline, setOffline] = React.useState(false)
        const [canvasReady, setCanvasReady] = React.useState(false)
        // 规范 4.1：customFrame 工作台不常驻会话区，只有用户主动选择 AI 协助时才显示。
        const [assist, setAssist] = React.useState(false)
        // 画布之外的写入（例如 Agent 调 board_write）只会改磁盘：轮询发现后提示重载，
        // 不自动重载，避免在画布自己保存的瞬间误判。
        const [externalStale, setExternalStale] = React.useState(false)
        const seenUpdatedAtRef = React.useRef('')
        const [hintVisible, setHintVisible] = React.useState(() => {
          try { return window.localStorage?.getItem(FIRST_USE_HINT_KEY) !== 'seen' } catch { return true }
        })
        const [workspaceList, setWorkspaceList] = React.useState([])
        const [workspaceId, setWorkspaceId] = React.useState('')

        const frameRef = React.useRef(null)
        const importRef = React.useRef(null)
        const snapshotRef = React.useRef({ counter: 0, pending: new Map() })
        // 画布还没就绪时收到的打开请求先存这里，等它报 ready 再发。
        const pendingLoadRef = React.useRef(null)

        const requestId = React.useCallback(() => {
          const store = snapshotRef.current
          store.counter += 1
          return `snapshot-${store.counter}`
        }, [])

        const message = React.useCallback((payload) => {
          const frame = frameRef.current
          if (!frame || !frame.contentWindow) return
          try {
            frame.contentWindow.postMessage({ channel: CHANNEL, ...payload }, window.location.origin)
          } catch {
            /* 画布尚未就绪时忽略 */
          }
        }, [])

        const refreshDocuments = React.useCallback(async (options = {}) => {
          const payload = await readDocuments()
          setDocuments(Array.isArray(payload?.documents) ? payload.documents : [])
          if (payload?.activeDocumentId) setActiveDocumentId(payload.activeDocumentId)
          if (options.reload) setReloadToken((token) => token + 1)
          return payload
        }, [])

        const describeError = React.useCallback((error) => (
          error && error.status === 404
            ? t('serverMissing')
            : ((error && error.message) || String(error))
        ), [t])

        const reportFailure = React.useCallback((scope, error) => {
          setStatus('error')
          setErrorText(error && error.status === 404 ? t('serverMissing') : `${scope}：${(error && error.message) || error}`)
        }, [t])

        /** 文档动作（新建/打开/删除/导入等）之后：列表与当前文档都换了，画布要跟着换。 */
        const applyDocumentResult = React.useCallback((payload) => {
          if (Array.isArray(payload?.documents)) setDocuments(payload.documents)
          const nextId = payload?.activeDocumentId || activeDocumentId
          if (payload?.activeDocumentId) setActiveDocumentId(payload.activeDocumentId)
          setDirty(false)
          setExternalStale(false)
          seenUpdatedAtRef.current = ''
          // 画布自己会去 /session 取数据；这里只让它重挂一次，避免残留旧画板状态。
          setCanvasReady(false)
          setReloadToken((token) => token + 1)
          pendingLoadRef.current = payload?.document ? { documentId: nextId, data: payload.document.data } : null
        }, [activeDocumentId])

        const run = React.useCallback(async (task) => {
          setBusy(true)
          setErrorText('')
          try {
            await task()
          } catch (error) {
            setStatus('error')
            setErrorText(describeError(error))
          } finally {
            setBusy(false)
          }
        }, [describeError])

        const retryBoot = React.useCallback(() => {
          setStatus('loading')
          setErrorText('')
          setCanvasReady(false)
          return refreshDocuments({ reload: true })
            .then(() => setStatus('ready'))
            .catch((error) => reportFailure(t('document'), error))
        }, [refreshDocuments, reportFailure, t])

        // 首次装载：读取画板列表。
        React.useEffect(() => {
          let cancelled = false
          refreshDocuments({ reload: false })
            .then(() => { if (!cancelled) setStatus('ready') })
            .catch((error) => { if (!cancelled) reportFailure(t('document'), error) })
          return () => { cancelled = true }
        }, [refreshDocuments, reportFailure, t])

        // 画布 → 宿主的消息。
        React.useEffect(() => {
          const onMessage = (event) => {
            if (event.origin !== window.location.origin) return
            const payload = event.data
            if (!payload || payload.channel !== CHANNEL) return

            if (payload.type === 'ready' || payload.type === 'canvas-ready') {
              setCanvasReady(true)
              setStatus('ready')
              setErrorText('')
              setExternalStale(false)
              seenUpdatedAtRef.current = ''
              if (typeof payload.offline === 'boolean') setOffline(payload.offline)
              if (typeof payload.documentId === 'string' && payload.documentId) setActiveDocumentId(payload.documentId)
              // 之前的打开请求因为画布没就绪被挂起了，现在补发。
              const pending = pendingLoadRef.current
              if (pending) {
                pendingLoadRef.current = null
                message({ type: 'load', documentId: pending.documentId, data: pending.data })
              }
              return
            }
            if (payload.type === 'saved') {
              setDirty(false)
              // 画布自己保存产生的 updatedAt 也要记成「已见过」，
              // 否则下面的轮询会把它误判成外部写入并提示重载。
              if (typeof payload.updatedAt === 'string' && payload.updatedAt) seenUpdatedAtRef.current = payload.updatedAt
              setSavedAt(payload.updatedAt || new Date().toISOString())
              setOffline(false)
              return
            }
            if (payload.type === 'dirty') {
              setDirty(true)
              return
            }
            if (payload.type === 'opened') {
              if (typeof payload.documentId === 'string' && payload.documentId) setActiveDocumentId(payload.documentId)
              setDirty(false)
              setStatus('ready')
              return
            }
            if (payload.type === 'error') {
              if (payload.scope === 'save') setDirty(true)
              if (payload.scope === 'boot') setOffline(true)
              setNotice(`${payload.scope}：${payload.message}`)
              return
            }
            if (payload.type === 'snapshot') {
              const pending = snapshotRef.current.pending.get(payload.requestId)
              if (pending) {
                snapshotRef.current.pending.delete(payload.requestId)
                pending.resolve(payload)
              }
              if (typeof payload.offline === 'boolean') setOffline(payload.offline)
            }
          }
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        }, [message])

        // 关闭窗口前让画布把未落盘的改动刷出去。
        React.useEffect(() => {
          const flush = () => { if (dirty) message({ type: 'flush' }) }
          window.addEventListener('beforeunload', flush)
          return () => {
            window.removeEventListener('beforeunload', flush)
            flush()
          }
        }, [dirty, message])

        const loadWorkspaces = React.useCallback(() => {
          try {
            const snapshot = service?.ctx?.workspaces?.list?.getSnapshot?.()
            const items = Array.isArray(snapshot?.items) ? snapshot.items : []
            const visible = items.filter((item) => typeof service?.workspaceVisible !== 'function'
              || service.workspaceVisible(item.workspaceId, entry?.id))
            setWorkspaceList(visible)
            setWorkspaceId((current) => (current && visible.some((item) => item.workspaceId === current)
              ? current
              : visible[0]?.workspaceId || ''))
          } catch {
            setWorkspaceList([])
          }
        }, [service, entry])

        let hasSession = false
        try {
          const sessionId = typeof service?.currentSession === 'function' ? service.currentSession() : null
          hasSession = !!sessionId && service?.state?.sessionBindings?.[sessionId] === entry?.id
        } catch {
          hasSession = false
        }

        // 无会话时也不自动创建：先给出本工作台自己的入口，由用户点选后才能建会话。
        React.useEffect(() => {
          if (assist && !hasSession) loadWorkspaces()
        }, [assist, hasSession, loadWorkspaces])

        const dismissHint = React.useCallback(() => {
          setHintVisible(false)
          try { window.localStorage?.setItem(FIRST_USE_HINT_KEY, 'seen') } catch { /* 存储不可用时只影响本次提示 */ }
        }, [])

        const openDocument = (id) => run(async () => {
          if (id === activeDocumentId) {
            setCanvasReady(false)
            setReloadToken((token) => token + 1)
            return
          }
          // documents 的 open 动作会把「当前文档」切过去并带回该文档数据；
          // 画布就绪时直接下发 load（不重挂 iframe，快且不丢应用状态）。
          const payload = await writeDocuments({ action: 'open', id })
          if (Array.isArray(payload?.documents)) setDocuments(payload.documents)
          setActiveDocumentId(payload?.activeDocumentId || id)
          setDirty(false)
          setExternalStale(false)
          seenUpdatedAtRef.current = ''
          const next = payload?.document ? { documentId: payload.activeDocumentId || id, data: payload.document.data } : null
          if (!next) return
          if (canvasReady) message({ type: 'load', ...next })
          else pendingLoadRef.current = next
        })

        const confirmDialog = (value) => {
          const current = dialog
          setDialog(null)
          if (!current) return
          if (current.kind === 'create') {
            return run(async () => applyDocumentResult(await writeDocuments({ action: 'create', name: value })))
          }
          if (current.kind === 'rename') {
            return run(async () => {
              const payload = await writeDocuments({ action: 'rename', id: current.id, name: value })
              if (Array.isArray(payload?.documents)) setDocuments(payload.documents)
            })
          }
          if (current.kind === 'delete') {
            return run(async () => applyDocumentResult(await writeDocuments({ action: 'delete', id: current.id })))
          }
          return undefined
        }

        const duplicateDocument = () => {
          const id = activeDocumentId
          if (!id) return
          return run(async () => applyDocumentResult(await writeDocuments({ action: 'duplicate', id })))
        }

        const importDocument = (file) => run(async () => {
          const text = await file.text()
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            throw new Error(t('importInvalid'))
          }
          // 接受三种写法：本工作台导出的裸 .drawnix、被包装过的 { data }、以及
          // 画布内部状态 { children }。服务端会再归一化一次。
          const data = parsed && parsed.data && (Array.isArray(parsed.data.elements) || Array.isArray(parsed.data.children))
            ? parsed.data
            : parsed
          if (!data || typeof data !== 'object'
            || (!Array.isArray(data.elements) && !Array.isArray(data.children))) {
            throw new Error(t('importInvalid'))
          }
          const name = file.name.replace(/\.(drawnix|json)$/i, '') || t('defaultName')
          applyDocumentResult(await writeDocuments({ action: 'import', name, data }))
        })

        const requestSnapshot = React.useCallback(() => new Promise((resolve, reject) => {
          const id = requestId()
          const store = snapshotRef.current
          const timer = setTimeout(() => {
            store.pending.delete(id)
            reject(new Error(t('exportFailed')))
          }, SNAPSHOT_TIMEOUT_MS)
          store.pending.set(id, {
            resolve: (payload) => { clearTimeout(timer); resolve(payload) },
            reject
          })
          message({ type: 'snapshot', requestId: id })
        }), [message, requestId, t])

        const exportDocument = () => run(async () => {
          const payload = await requestSnapshot()
          const name = documents.find((item) => item.id === activeDocumentId)?.name || 'board'
          // 导出的就是 .drawnix 本体：可以直接用白板的「打开文件」再打开，也可以再导入回来。
          downloadJson(`${name}.drawnix`, payload.data)
        })

        const saveNow = () => run(async () => {
          // 先让画布把内存状态刷到服务端，再刷新画板列表。
          message({ type: 'flush' })
          await new Promise((resolve) => setTimeout(resolve, 250))
          await refreshDocuments()
          setSavedAt(new Date().toISOString())
        })

        const useWorkspace = () => {
          if (!workspaceId) return
          return run(async () => {
            if (typeof service?.newSession === 'function') await service.newSession(workspaceId)
          })
        }

        const startWorkspaceSession = () => run(async () => {
          if (typeof service?.newWorkspaceSession === 'function') await service.newWorkspaceSession()
        })

        const statusState = offline ? 'offline' : dirty ? 'saving' : canvasReady ? 'ready' : 'loading'
        const statusText = offline
          ? t('statusOffline')
          : dirty
            ? t('statusSaving')
            : canvasReady
              ? `${t('statusSaved')}${savedAt ? ` · ${formatClock(savedAt)}` : ''}`
              : t('statusLoading')

        const reloadCanvas = () => {
          setExternalStale(false)
          setCanvasReady(false)
          setReloadToken((token) => token + 1)
        }

        // 轮询画板列表，发现「当前画板被画布之外的写入更新」时给出提示。
        // 首次观测只建立基线；画布自己的保存会先把 updatedAt 记进 seenUpdatedAtRef，
        // 所以这里不会因为自己保存而误报。
        React.useEffect(() => {
          if (!canvasReady) return undefined
          const timer = setInterval(() => {
            readDocuments().then((payload) => {
              const list = Array.isArray(payload?.documents) ? payload.documents : []
              setDocuments(list)
              const id = payload?.activeDocumentId || activeDocumentId
              const nextUpdatedAt = list.find((item) => item.id === id)?.updatedAt || ''
              if (!seenUpdatedAtRef.current) {
                seenUpdatedAtRef.current = nextUpdatedAt
                return
              }
              if (payload?.activeDocumentId && payload.activeDocumentId !== activeDocumentId) {
                setExternalStale(true)
                return
              }
              if (nextUpdatedAt && nextUpdatedAt !== seenUpdatedAtRef.current) setExternalStale(true)
            }).catch(() => { /* 轮询失败不打扰用户，下一轮再试 */ })
          }, EXTERNAL_POLL_MS)
          return () => clearInterval(timer)
        }, [canvasReady, activeDocumentId])

        const activeDocument = documents.find((item) => item.id === activeDocumentId)

        return h('div', { className: 'dshDw', 'data-active': active === false ? 'false' : 'true' },
          h('header', { className: 'dshDwToolbar', 'aria-label': t('panelTitle') },
            h('div', { className: 'dshDwBrand' },
              h('span', { className: 'dshDwBrandMark', 'aria-hidden': 'true' }, '画'),
              h('span', null, t('title'))
            ),
            h('div', { className: 'dshDwGroup' },
              h('label', { className: 'dshDwHidden', htmlFor: 'dshDwDocument' }, t('document')),
              h('select', {
                id: 'dshDwDocument',
                className: 'dshDwSelect',
                value: activeDocumentId,
                disabled: busy || !documents.length,
                onChange: (event) => openDocument(event.target.value)
              },
              documents.length
                ? documents.map((item) => h('option', { key: item.id, value: item.id }, item.name))
                : h('option', { value: '' }, t('noDocuments')))
            ),
            h('div', { className: 'dshDwGroup' },
              h('button', { type: 'button', className: 'dshDwBtn', disabled: busy, onClick: () => setDialog({ kind: 'create', initialValue: t('defaultName') }) }, t('newDocument')),
              h('button', { type: 'button', className: 'dshDwBtn', disabled: busy || !activeDocumentId, onClick: () => setDialog({ kind: 'rename', id: activeDocumentId, initialValue: activeDocument?.name || '' }) }, t('rename')),
              h('button', { type: 'button', className: 'dshDwBtn', disabled: busy || !activeDocumentId, onClick: duplicateDocument }, t('duplicate')),
              h('button', { type: 'button', className: 'dshDwBtn', disabled: busy || !activeDocumentId || activeDocumentId === 'default', onClick: () => setDialog({ kind: 'delete', id: activeDocumentId, initialValue: activeDocument?.name || '' }) }, t('remove'))
            ),
            h('div', { className: 'dshDwGroup' },
              h('button', { type: 'button', className: 'dshDwBtn', disabled: busy || !canvasReady, onClick: () => importRef.current?.click() }, t('importDocument')),
              h('button', { type: 'button', className: 'dshDwBtn', disabled: busy || !canvasReady, onClick: exportDocument }, t('exportDocument')),
              h('button', { type: 'button', className: 'dshDwBtn', disabled: busy || !canvasReady, onClick: saveNow }, t('saveNow')),
              h('button', { type: 'button', className: 'dshDwBtn', 'data-variant': 'ghost', disabled: busy, onClick: reloadCanvas }, t('reload'))
            ),
            h('div', { className: 'dshDwSpacer' }),
            h('div', { className: 'dshDwStatus', 'data-tone': statusState === 'offline' ? 'error' : undefined, role: 'status', 'aria-live': 'polite' },
              h('span', { className: 'dshDwDot', 'data-state': statusState, 'aria-hidden': 'true' }),
              h('span', null, statusText)
            ),
            h('button', {
              type: 'button',
              className: 'dshDwBtn',
              'data-variant': assist ? 'primary' : undefined,
              'aria-pressed': assist ? 'true' : 'false',
              onClick: () => setAssist((open) => !open)
            }, assist ? t('aiAssistOn') : t('aiAssist'))
          ),
          offline ? h('div', { className: 'dshDwWarn', role: 'alert' }, t('statusOffline')) : null,
          errorText
            ? h('div', { className: 'dshDwWarn', role: 'alert' }, `${errorText} `,
              h('button', { type: 'button', className: 'dshDwBtn', onClick: retryBoot }, t('retry')))
            : null,
          notice
            ? h('div', { className: 'dshDwWarn', role: 'status' },
              `${notice} `,
              h('button', { type: 'button', className: 'dshDwBtn', onClick: () => setNotice('') }, t('cancel')))
            : null,
          // 外部写入（Agent 调 board_write）只改磁盘，画布不会自己知道：提示用户重载。
          externalStale
            ? h('div', { className: 'dshDwWarn', role: 'status' },
              `${t('externalUpdate')} `,
              h('button', { type: 'button', className: 'dshDwBtn', onClick: reloadCanvas }, t('reload')),
              h('button', { type: 'button', className: 'dshDwBtn', 'data-variant': 'ghost', onClick: () => setExternalStale(false) }, t('cancel')))
            : null,
          h('div', { className: 'dshDwBody' },
            h('div', { className: 'dshDwCanvas' },
              h('div', { className: 'dshDwFrameWrap' },
                h('iframe', {
                  key: reloadToken,
                  ref: frameRef,
                  className: 'dshDwFrame',
                  title: t('title'),
                  src: APP_URL,
                  // 白板的「演示模式」调用 requestFullscreen：iframe 必须显式授予该权限
                  // （Permissions Policy，另有 allowFullScreen 兼容旧写法），否则调用被拒，
                  // 表现为「点演示模式没有反应」。
                  allow: 'fullscreen',
                  allowFullScreen: true,
                  // 画布是应用自身的完整 UI，需要脚本、表单与弹层能力；
                  // 它与 DSH 渲染进程同源，因此只放行同源能力。
                  sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups',
                  onLoad: () => setCanvasReady(false)
                }),
                // 服务端路由不可用时画布必然载不出来：给出可操作的提示与重试，而不是一直「正在载入…」。
                !canvasReady && status === 'error'
                  ? h('div', { className: 'dshDwOverlay', role: 'alert' },
                    h('strong', null, t('bootError')),
                    h('span', null, errorText || t('serverMissing')),
                    h('button', { type: 'button', className: 'dshDwBtn', onClick: retryBoot }, t('retry')))
                  : !canvasReady && !offline
                    ? h('div', { className: 'dshDwOverlay', role: 'status' }, h('strong', null, t('title')), h('span', null, t('statusLoading')))
                    : null,
                offline
                  ? h('div', { className: 'dshDwOverlay', role: 'alert' },
                    h('strong', null, t('bootError')),
                    h('span', null, t('statusOffline')))
                  : null
              )
            ),
            // 会话区默认收起（规范 4.1）：收起时画布占满主内容区；
            // 节点始终保留在文档中，宿主传入的输入树不会被反复卸载重建。
            h('aside', {
              className: 'dshDwDock',
              'aria-label': t('session'),
              hidden: !assist
            },
            conversation
              ? h('div', { className: 'dshDwDockFill', hidden: !hasSession }, conversation)
              : null,
            !hasSession
              ? h('div', { className: 'dshDwSession' },
                h('h2', null, t('sessionSetupTitle')),
                h('p', null, t('sessionSetupBody')),
                h('div', { className: 'dshDwSessionRow' },
                  h('button', {
                    type: 'button',
                    className: 'dshDwBtn',
                    'data-variant': 'primary',
                    disabled: busy,
                    onClick: startWorkspaceSession
                  }, t('newWorkspaceSession')),
                  workspaceList.length
                    ? h('span', { className: 'dshDwSessionRow' },
                      h('label', { className: 'dshDwHidden', htmlFor: 'dshDwWorkspace' }, t('workspaceLabel')),
                      h('select', {
                        id: 'dshDwWorkspace',
                        className: 'dshDwSelect',
                        value: workspaceId,
                        disabled: busy,
                        onChange: (event) => setWorkspaceId(event.target.value)
                      }, workspaceList.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId }, item.title || item.workspaceId))),
                      h('button', {
                        type: 'button',
                        className: 'dshDwBtn',
                        disabled: busy || !workspaceId,
                        onClick: useWorkspace
                      }, t('useWorkspace')))
                    : h('span', null, t('noWorkspace'))
                ))
              : null
            )
          ),
          // 本工作台自己的首次进入状态：一行可关闭的说明，不占用聊天区。
          hintVisible
            ? h('div', { className: 'dshDwHint', role: 'status' },
              h('span', null, t('firstUseHint')),
              h('button', { type: 'button', className: 'dshDwBtn', 'data-variant': 'ghost', onClick: dismissHint }, t('dismiss')))
            : null,
          h('input', {
            ref: importRef,
            className: 'dshDwHidden',
            type: 'file',
            accept: '.drawnix,.json,application/json',
            onChange: (event) => {
              const file = event.target.files && event.target.files[0]
              event.target.value = ''
              if (file) importDocument(file).catch(() => {})
            }
          }),
          dialog
            ? h(Dialog, {
              title: dialog.kind === 'create' ? t('createTitle') : dialog.kind === 'rename' ? t('renameTitle') : t('deleteTitle'),
              description: dialog.kind === 'delete' ? t('deleteBody') : null,
              label: dialog.kind === 'delete' ? null : t('createLabel'),
              initialValue: dialog.initialValue,
              confirmText: dialog.kind === 'create' ? t('createConfirm') : dialog.kind === 'rename' ? t('renameConfirm') : t('deleteConfirm'),
              cancelText: t('cancel'),
              tone: dialog.kind === 'delete' ? 'danger' : 'primary',
              busy,
              onConfirm: confirmDialog,
              onCancel: () => setDialog(null)
            })
            : null
        )
      }
    }

    // ---------------------------------------------------------------- 装配 ----

    function apply(ctx) {
      installStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-draw-workbench: dictionaries')
      const t = ctx.locale.bind(NS)
      const Panel = createPanel(t)
      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: 'DSH 画板',
        titleEn: 'DSH Draw Workbench',
        panelTitle: 'DSH 画板',
        description: '在工作台里画流程图、架构图、思维导图与手绘草图；文档保存在 DSH 数据目录，可与会话并行使用。',
        repository: REPOSITORY,
        // 本地展示用的分类标签（宿主 register 的默认值是「其他」，接受的是展示名而不是 id；
        // 上架后以市场目录条目里的 category 为权威值）。
        category: '效率',
        // 白板需要尽可能大的画布：使用 customFrame 占据主内容区，
        // 并自行把宿主提供的原生会话节点停靠在右侧（不新建聊天界面）。
        customFrame: true
      }, Panel), 'dsh-draw-workbench: registration')
    }

    return { apply, inject: ['desktopWorkbenches', 'locale'] }
  }
})
