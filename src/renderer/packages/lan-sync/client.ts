import {
  LAN_SYNC_PROTOCOL_VERSION,
  LanSyncHttpPath,
  type LanSyncPackage,
} from '@shared/lan-sync/protocol'
import storage from '../../storage'
import { getMetaStorage, getSessionMeta } from '../../stores/sessionHelpers'
import { createSessionMetaRecordsFromLegacyList } from '../../utils/session-utils'

/** 容错地把用户输入变成 base url：允许只写 `192.168.0.113:17878`。 */
export function normalizeBaseUrl(input: string): string {
  let raw = (input || '').trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw)) {
    raw = `http://${raw}`
  }
  return raw.replace(/\/+$/, '')
}

export interface LanSyncServerInfo {
  deviceName: string
  protocolVersion: number
}

/**
 * token 无效（HTTP 401）：电脑端换过配对码，或令牌被重置。
 * 手机端据此判定「自动重连失败」并清掉本地 token，退回「需要配对」。
 */
export class LanSyncAuthError extends Error {
  readonly status = 401

  constructor(message: string) {
    super(message)
    this.name = 'LanSyncAuthError'
  }
}

/** 判定一个异常是不是「令牌失效」（跨模块副本也认，所以比对 name）。 */
export function isLanSyncAuthError(error: unknown): boolean {
  return error instanceof Error && error.name === 'LanSyncAuthError'
}

/** GET /lan-sync/info —— 不需要配对，用于「连得上吗 / 对方是谁」。 */
export async function fetchServerInfo(baseUrl: string): Promise<LanSyncServerInfo> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${LanSyncHttpPath.Info}`)
  if (!response.ok) {
    throw new Error(`无法连接电脑端（HTTP ${response.status}）`)
  }
  const data = (await response.json()) as { deviceName?: string; protocolVersion?: number }
  return {
    deviceName: data.deviceName || 'Chatbox',
    protocolVersion: data.protocolVersion || LAN_SYNC_PROTOCOL_VERSION,
  }
}

/** POST /lan-sync/handshake —— 用 6 位配对码换长期令牌。 */
export async function handshake(
  baseUrl: string,
  code: string,
): Promise<{ token: string; deviceName: string }> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${LanSyncHttpPath.Handshake}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    token?: string
    deviceName?: string
    error?: string
  }
  if (!response.ok || !data.ok || !data.token) {
    throw new Error(data.error || `配对失败（HTTP ${response.status}）`)
  }
  return { token: data.token, deviceName: data.deviceName || 'Chatbox' }
}

/** GET /lan-sync/package —— 取走当前这一批数据。 */
export async function fetchPackage(baseUrl: string, token: string): Promise<LanSyncPackage> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${LanSyncHttpPath.Package}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean
    package?: LanSyncPackage
    error?: string
  }
  if (!response.ok || !data.ok || !data.package) {
    if (response.status === 401) {
      throw new LanSyncAuthError(data.error || '令牌已失效，请重新配对')
    }
    throw new Error(data.error || `拉取数据失败（HTTP ${response.status}）`)
  }
  return data.package
}

/**
 * POST /lan-sync/forward —— 把在「电脑端会话」里输入的消息转发回电脑端，由电脑端真正发送
 * （第 20 轮，需求 2）。服务端只把它交给 renderer，不在这里等回复；电脑端生成完会把新包
 * 沿 SSE 推过来，手机端随之自动补齐。
 */
export async function forwardMessageToDesktop(
  baseUrl: string,
  token: string,
  message: { sessionId: string; text: string },
): Promise<void> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${LanSyncHttpPath.Forward}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(message),
  })
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!response.ok || !data.ok) {
    if (response.status === 401) {
      throw new LanSyncAuthError(data.error || '令牌已失效，请重新配对')
    }
    throw new Error(data.error || `转发到电脑端失败（HTTP ${response.status}）`)
  }
}

export interface ApplyPackageResult {
  written: number
  sessions: number
  mode: 'full' | 'incremental'
  deviceName: string
  /** 回填到会话列表（chatbox-session-meta）里的条数，0 表示只落盘了正文、列表不会显示 */
  metaWritten: number
}

/**
 * 落地同步包：entries 就是原始 store 键值对，直接整批写进本机存储。
 *
 * 但**列表和正文是两个存储**：正文在 store（`session:<id>`），左侧栏却是从
 * chatbox-session-meta 读的（桌面 IndexedDB / 手机 SQLite）。只 setAll 的话，
 * 会话正文进来了、列表一条都不会出现，所以这里必须按收到的会话重建元数据。
 * 重建方式与 init_data / migration 里的官方口径一致（getSessionMeta +
 * createSessionMetaRecordsFromLegacyList），保证字段（starred、排序等）与产品一致。
 */
export async function applyPackage(pkg: LanSyncPackage): Promise<ApplyPackageResult> {
  const entries = pkg.entries || {}
  await storage.setAll(entries)

  let metaWritten = 0
  try {
    const sessionObjects = Object.entries(entries)
      .filter(([key]) => key.startsWith('session:'))
      .map(([, value]) => value as Parameters<typeof getSessionMeta>[0])
    if (sessionObjects.length > 0) {
      const metaStorage = await getMetaStorage()
      const records = createSessionMetaRecordsFromLegacyList(sessionObjects.map((session) => getSessionMeta(session)))
      await metaStorage.createMany(records)
      metaWritten = records.length
    }
  } catch (error) {
    // 元数据失败不该让整次同步报错：正文已经落盘了
    console.error('[lan-sync] 回填会话列表元数据失败：', error)
  }

  return {
    written: Object.keys(entries).length,
    sessions: pkg.sessionCount ?? 0,
    mode: pkg.mode === 'full' ? 'full' : 'incremental',
    deviceName: pkg.deviceName || 'Chatbox',
    metaWritten,
  }
}

export interface LanSyncSubscription {
  close: () => void
}

/**
 * 订阅电脑端推送（SSE）。
 * 用 EventSource 而不是 WebSocket：单向 server→client 足够，浏览器原生支持、服务端实现只要几十行。
 * 注意 EventSource 不能带自定义请求头，token 走 query。
 */
export function subscribePackageEvents(
  baseUrl: string,
  token: string,
  handlers: {
    onReady?: (info: { deviceName: string; hasPackage: boolean }) => void
    onPackage: (notice: { batchId: string; mode: 'full' | 'incremental'; sessionCount: number }) => void
    onError?: (message: string) => void
    /**
     * 服务端主动撤销了本机令牌（桌面端点「重新生成配对码」时会先推 revoke 再断流）。
     * 第 19 轮补上：之前没人监听这个事件，手机端只能靠刷新页面才发现自己被踢了。
     */
    onRevoke?: (info: { reason?: string }) => void
  },
): LanSyncSubscription {
  const url = `${normalizeBaseUrl(baseUrl)}${LanSyncHttpPath.Events}?token=${encodeURIComponent(token)}`
  const source = new EventSource(url)

  source.addEventListener('ready', (event) => {
    try {
      handlers.onReady?.(JSON.parse((event as MessageEvent).data))
    } catch {
      handlers.onReady?.({ deviceName: 'Chatbox', hasPackage: false })
    }
  })

  source.addEventListener('package', (event) => {
    try {
      handlers.onPackage(JSON.parse((event as MessageEvent).data))
    } catch {
      // 忽略坏消息
    }
  })

  source.addEventListener('revoke', (event) => {
    let reason: string | undefined
    try {
      reason = (JSON.parse((event as MessageEvent).data) as { reason?: string }).reason
    } catch {
      // 忽略坏消息
    }
    handlers.onRevoke?.({ reason })
  })

  source.addEventListener('error', () => {
    // EventSource 会自动重连；仅在彻底关闭时提示
    if (source.readyState === EventSource.CLOSED) {
      handlers.onError?.('与电脑端的连接已断开')
    }
  })

  return {
    close: () => source.close(),
  }
}
