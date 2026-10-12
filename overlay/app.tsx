/**
 * DSH 画板工作台 · 内嵌白板的应用外壳（overlay）。
 *
 * 本文件由 `scripts/canvas-overlay.mjs` 覆盖到白板项目 `apps/web/src/app/app.tsx`，
 * 是**唯一**被改写的业务文件，改的只有数据来源，白板本身（组件、工具、渲染）
 * 一行未动。
 *
 * 与白板项目版本的差别：
 *   1. 数据不再存在浏览器 IndexedDB（localforage），而是走本工作台自己的
 *      服务端接口 `/api/dsh-draw-workbench/...`，落进 DSH 数据目录；
 *   2. 支持「多文档」：面板通过 postMessage 下发要打开的画板；
 *   3. 画布侧改动防抖回写，并在页面隐藏/卸载时用 sendBeacon 尽力补一次；
 *   4. 与面板的协议见下（channel = dsh-draw-workbench），两侧对称实现。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawnix, type DrawnixToolState, type Language } from '@drawnix/drawnix';
import { PlaitElement, PlaitTheme, Viewport } from '@plait/core';

const API = '/api/dsh-draw-workbench';
const CHANNEL = 'dsh-draw-workbench';
const SAVE_DELAY = 400;
const PREFERENCE_DELAY = 600;

type BoardValue = {
  children: PlaitElement[];
  viewport?: Viewport;
  theme?: PlaitTheme;
};

type Preference = {
  language?: Language;
  copyTransparent?: boolean;
  exportTransparent?: boolean;
};

/** 面板 → 画布 与 画布 → 面板 的消息都带这个 channel，避免与其他插件串台。 */
function notify(type: string, detail?: Record<string, unknown>) {
  try {
    window.parent.postMessage({ channel: CHANNEL, type, ...(detail || {}) }, window.location.origin);
  } catch {
    /* 不在同源父窗口里（例如直接开页面调试）时忽略：应用自身仍能独立工作 */
  }
}

function boardToValue(data: any): BoardValue {
  if (!data || typeof data !== 'object') return { children: [] };
  const children = Array.isArray(data.elements)
    ? data.elements
    : Array.isArray(data.children)
      ? data.children
      : [];
  return { children, viewport: data.viewport, theme: data.theme };
}

function valueToBoard(value: BoardValue, theme?: PlaitTheme) {
  return {
    type: 'drawnix',
    version: 1,
    source: 'web',
    elements: value.children || [],
    viewport: value.viewport || { zoom: 1 },
    ...(value.theme || theme ? { theme: value.theme || theme } : {}),
  };
}

export function App() {
  const [value, setValue] = useState<BoardValue>({ children: [] });
  const [preference, setPreference] = useState<Preference>({ language: 'zh' });
  const [initialToolState, setInitialToolState] = useState<Partial<DrawnixToolState>>();
  const [tutorial, setTutorial] = useState(false);
  // 切换画板时靠改 key 强制重挂白板：白板项目只把 value 当初始值用，
  // 单纯 setState 不会让画布换成另一份数据。
  const [boardKey, setBoardKey] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // 保存要用「当前」的文档与数据，而 postMessage / pagehide 回调拿不到最新的 state，
  // 所以镜像到 ref 里。
  const documentIdRef = useRef<string | null>(null);
  const valueRef = useRef<BoardValue>(value);
  const offlineRef = useRef(false);
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const preferenceTimer = useRef<number | null>(null);
  const pendingPreference = useRef<Preference>({});

  valueRef.current = value;

  const persist = useCallback((documentId: string | null, board: BoardValue) => {
    if (offlineRef.current || !documentId) return Promise.resolve();
    if (savingRef.current) {
      queuedRef.current = true;
      return Promise.resolve();
    }
    savingRef.current = true;
    return fetch(`${API}/session/data`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId, data: valueToBoard(board) }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        dirtyRef.current = false;
        notify('saved', { documentId, updatedAt: payload?.updatedAt || null });
      })
      .catch((error) => {
        notify('error', { scope: 'save', message: String((error && error.message) || error) });
      })
      .then(() => {
        savingRef.current = false;
        if (queuedRef.current) {
          queuedRef.current = false;
          scheduleSave();
        }
      });
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void persist(documentIdRef.current, valueRef.current);
    }, SAVE_DELAY);
  }, [persist]);

  const applyBoard = useCallback((documentId: string | null, data: any) => {
    const next = boardToValue(data);
    setValue(next);
    setTutorial(!next.children.length);
    setBoardKey((key) => key + 1);
    documentIdRef.current = documentId;
    dirtyRef.current = false;
  }, []);

  // 页面隐藏 / 卸载时尽力补一次落盘：卸载阶段同步 fetch 不可靠，用 sendBeacon。
  useEffect(() => {
    const flushBeacon = () => {
      const documentId = documentIdRef.current;
      if (offlineRef.current || !documentId || !dirtyRef.current) return;
      const body = JSON.stringify({ documentId, data: valueToBoard(valueRef.current) });
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(`${API}/session/data`, new Blob([body], { type: 'application/json' }));
        } else {
          void persist(documentId, valueRef.current);
        }
      } catch {
        /* 卸载阶段的尽力而为，失败即放弃 */
      }
    };
    window.addEventListener('pagehide', flushBeacon);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushBeacon();
    });
    return () => window.removeEventListener('pagehide', flushBeacon);
  }, [persist]);

  // 面板指令：load 打开指定画板 / flush 立即落盘 / snapshot 取回当前数据 / reload 重载。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || message.channel !== CHANNEL) return;

      if (message.type === 'load') {
        // 先把手上的改动落到**旧**文档，再切——否则切走的那几秒改动会写进新文档。
        const previousId = documentIdRef.current;
        const previousValue = valueRef.current;
        const switching = previousId !== (message.documentId || null);
        const flush = switching && dirtyRef.current ? persist(previousId, previousValue) : Promise.resolve();
        void flush.then(() => {
          applyBoard(message.documentId || null, message.data);
          notify('opened', { documentId: message.documentId || null });
        });
      } else if (message.type === 'flush') {
        if (saveTimer.current !== null) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        void persist(documentIdRef.current, valueRef.current);
      } else if (message.type === 'snapshot') {
        void persist(documentIdRef.current, valueRef.current).then(() => {
          notify('snapshot', {
            requestId: message.requestId || null,
            documentId: documentIdRef.current,
            data: valueToBoard(valueRef.current),
            offline: offlineRef.current,
          });
        });
      } else if (message.type === 'reload') {
        window.location.reload();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [applyBoard, persist]);

  const flushPreference = useCallback(() => {
    const payload = pendingPreference.current;
    pendingPreference.current = {};
    if (offlineRef.current || !Object.keys(payload).length) return;
    fetch(`${API}/session/preferences`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preference: payload }),
    }).catch(() => {
      /* 偏好写失败不影响画板使用 */
    });
  }, []);

  const updatePreference = useCallback((patch: Preference) => {
    setPreference((current) => ({ ...current, ...patch }));
    pendingPreference.current = { ...pendingPreference.current, ...patch };
    if (preferenceTimer.current !== null) window.clearTimeout(preferenceTimer.current);
    preferenceTimer.current = window.setTimeout(() => {
      preferenceTimer.current = null;
      flushPreference();
    }, PREFERENCE_DELAY);
  }, [flushPreference]);

  // 启动：向工作台服务端要当前文档与偏好设置。
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/session`, { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        applyBoard(payload.documentId || null, payload.document?.data);
        const stored = payload.preference && typeof payload.preference === 'object' ? payload.preference : {};
        if (stored.language) setPreference((current) => ({ ...current, ...stored }));
        setLoaded(true);
        notify('ready', { documentId: payload.documentId || null, offline: false });
      })
      .catch((error) => {
        if (cancelled) return;
        offlineRef.current = true;
        setLoaded(true);
        setTutorial(true);
        notify('ready', { documentId: null, offline: true });
        notify('error', { scope: 'boot', message: String((error && error.message) || error) });
      });
    return () => {
      cancelled = true;
    };
  }, [applyBoard]);

  if (!loaded) return null;

  return (
    <Drawnix
      key={boardKey}
      value={value.children}
      viewport={value.viewport}
      theme={value.theme}
      initialToolState={initialToolState}
      initialLanguage={preference.language}
      initialPreference={{
        copyTransparent: preference.copyTransparent,
        exportTransparent: preference.exportTransparent,
      }}
      onLanguageChange={(language) => {
        updatePreference({ language });
      }}
      onPreferenceChange={({ copyTransparent, exportTransparent }) => {
        updatePreference({ copyTransparent, exportTransparent });
      }}
      onChange={(next) => {
        const changed = next as BoardValue;
        const withTheme = { ...changed, theme: changed.theme || valueRef.current.theme };
        valueRef.current = withTheme;
        setValue(withTheme);
        if (!dirtyRef.current) {
          dirtyRef.current = true;
          notify('dirty');
        }
        scheduleSave();
      }}
      onToolStateChange={(toolState) => {
        // 选中哪个工具属于会话级状态，不值得落盘（重启后回到默认选择更符合预期）。
        setInitialToolState(toolState);
      }}
      tutorial={tutorial}
      afterInit={() => {
        notify('canvas-ready', { documentId: documentIdRef.current });
      }}
    ></Drawnix>
  );
}

export default App;
