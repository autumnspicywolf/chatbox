/**
 * 局域网同步 —— Web / 手机端（客户端）连接管理（第 19 轮）。
 *
 * 为什么要有这个文件：旧实现把「自动重连 + 订阅 SSE」放在 LanSyncSetting 的
 * ClientPanel 里，于是这条长连接的生命周期 = 那个设置面板开着的时间：
 * 切走设置页就断、关掉页面更断。而桌面端靠 `connectedClients > 0` 判断「手机在线」，
 * 结果就是电脑侧边栏一直显示「等待手机连接」，一旦手机离开面板又立刻变成 0 台。
 *
 * 现在：连接在 renderer 启动时初始化一次（见 index.tsx），**不依赖任何 React 组件挂载**，
 * 只要整个页面开着就保持 SSE；设置面板退化成纯 UI，只读状态 + 触发手动操作。
 *
 * 判据（第 19 轮一并修正）：`connected` 只有在收到服务端 `ready` 事件后才置真。
 * 旧实现是 fetchServerInfo（普通 HTTP）成功就置真，SSE 根本没连上也显示「已连接」，
 * 会和桌面端的「等待手机连接」直接打架。
 *
 * 对齐语义（需求 2 的配套）：每次 `ready`（首次连接 / 断线重连后）都补拉一次当前包，
 * 因此电脑端在手机离线期间推的包也能在手机下次上线时补齐。
 */

import { create } from 'zustand'
import { LAN_SYNC_DEFAULT_PORT } from '@shared/lan-sync/protocol'
import { rendererApplication } from '@/app/renderer-application'
import platform from '@/platform'
import {
  applyPackage,
  fetchPackage,
  fetchServerInfo,
  forwardMessageToDesktop,
  handshake,
  isLanSyncAuthError,
  type LanSyncSubscription,
  normalizeBaseUrl,
  subscribePackageEvents,
} from '@/packages/lan-sync/client'
import { markLanSyncImportedSessions } from '@/stores/lan-sync-imported'
import { playLanSyncTaskCompleteSounds } from '@/stores/task-complete-sound'

/** 电脑端地址（形如 http://192.168.0.113:17878）持久化在 localStorage。 */
export const LAN_SYNC_CLIENT_URL_KEY = 'lan-sync:client:url'
/**
 * 令牌持久化在 localStorage（第 18 轮从 sessionStorage 搬过来）：关标签、电脑重启都还在，
 * 这才撑得起「下次打开自动重连」。
 */
export const LAN_SYNC_CLIENT_TOKEN_KEY = 'lan-sync:client:token'

/** `ready` 事件的等待超时：过了这么久还没连上，多半是长连接被浏览器 / 网络拦了。 */
const READY_TIMEOUT_MS = 8000
/** 鉴权探测节流：避免 EventSource 反复报错时把电脑端打爆。 */
const AUTH_PROBE_THROTTLE_MS = 10_000

export interface LanSyncClientRecord {
  mode: 'full' | 'incremental'
  sessions: number
  written: number
  deviceName: string
  at: number
}

export interface LanSyncClientNotice {
  type: 'success' | 'error' | 'info'
  text: string
}

interface LanSyncClientState {
  baseUrl: string
  token: string
  peerName: string
  connected: boolean
  connecting: boolean
  record: LanSyncClientRecord | null
  notice: LanSyncClientNotice | null
}

/** 只有非桌面端（web / mobile）才需要当客户端连电脑。 */
export function isLanSyncClientAvailable(): boolean {
  return platform.type !== 'desktop'
}

/** 默认地址：当前页面所在主机的 17878 端口。 */
export function defaultClientBaseUrl(): string {
  if (typeof window === 'undefined') {
    return `http://localhost:${LAN_SYNC_DEFAULT_PORT}`
  }
  return `${window.location.protocol}//${window.location.hostname}:${LAN_SYNC_DEFAULT_PORT}`
}

function readStoredUrl(): string {
  try {
    return localStorage.getItem(LAN_SYNC_CLIENT_URL_KEY) || defaultClientBaseUrl()
  } catch {
    return defaultClientBaseUrl()
  }
}

function readStoredToken(): string {
  try {
    return localStorage.getItem(LAN_SYNC_CLIENT_TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

function persistUrl(url: string): void {
  try {
    localStorage.setItem(LAN_SYNC_CLIENT_URL_KEY, url)
  } catch {
    // 忽略隐私模式等写失败
  }
}

function persistToken(token: string): void {
  try {
    localStorage.setItem(LAN_SYNC_CLIENT_TOKEN_KEY, token)
  } catch {
    // 忽略
  }
}

function clearStoredToken(): void {
  try {
    localStorage.removeItem(LAN_SYNC_CLIENT_TOKEN_KEY)
  } catch {
    // 忽略
  }
}

export const useLanSyncClientState = create<LanSyncClientState>(() => ({
  baseUrl: readStoredUrl(),
  token: readStoredToken(),
  peerName: '',
  connected: false,
  connecting: false,
  record: null,
  notice: null,
}))

let subscription: LanSyncSubscription | null = null
let readyTimer: ReturnType<typeof setTimeout> | null = null
let authProbeAt = 0
let initialized = false

function setState(partial: Partial<LanSyncClientState>): void {
  useLanSyncClientState.setState(partial)
}

function clearReadyTimer(): void {
  if (readyTimer) {
    clearTimeout(readyTimer)
    readyTimer = null
  }
}

function closeSubscription(): void {
  clearReadyTimer()
  subscription?.close()
  subscription = null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 需求 3：落地后立刻刷新界面（侧边栏会话列表 + 会话正文 / 设置）。 */
async function refreshUiAfterApply(): Promise<void> {
  try {
    const page = await rendererApplication.sessions.listSessionsMetaPage(0)
    rendererApplication.sessionQueryBridge.resetSessionList(page)
  } catch {
    // 会话列表刷新失败不阻断同步
  }
  void rendererApplication.queryClient.invalidateQueries({ queryKey: ['chat-session'] })
  void rendererApplication.queryClient.invalidateQueries({ queryKey: ['chat-session-settings'] })
  void rendererApplication.queryClient.invalidateQueries({ queryKey: ['archived-chat-sessions-list'] })
}

/** 从同步包里挑出会话 id（entries 的键形如 `session:<id>`）。 */
function sessionIdsFromPackage(entries: Record<string, unknown> | undefined): string[] {
  return Object.keys(entries || {})
    .filter((key) => key.startsWith('session:'))
    .map((key) => key.slice('session:'.length))
}

async function pullAndApply(activeToken: string, reason: string): Promise<void> {
  const pkg = await fetchPackage(useLanSyncClientState.getState().baseUrl, activeToken)
  const applied = await applyPackage(pkg)
  // 需求 1 / 2：记住哪些会话是电脑端来的 —— 列表要加图标，且往里发消息要转发回电脑端。
  markLanSyncImportedSessions(sessionIdsFromPackage(pkg.entries))
  // 第 21 轮：首次同步回「电脑端刚完成的工作模式任务」时响一次提示音（重复同步不会重复响）。
  playLanSyncTaskCompleteSounds(pkg.entries)
  setState({
    record: {
      mode: applied.mode,
      sessions: applied.sessions,
      written: applied.written,
      deviceName: applied.deviceName,
      at: Date.now(),
    },
  })
  await refreshUiAfterApply()
  setState({
    notice: {
      type: 'success',
      text: `${reason}：已写入 ${applied.written} 项（${applied.sessions} 个会话，列表回填 ${applied.metaWritten} 条），界面已自动刷新。`,
    },
  })
}

/** 令牌失效（电脑端换了配对码）：清掉本地令牌，退回「需要配对」。 */
function handleAuthRevoked(message = '电脑端已重新生成配对码，请重新输入配对码连接'): void {
  closeSubscription()
  clearStoredToken()
  setState({ token: '', connected: false, connecting: false, notice: { type: 'info', text: message } })
}

/**
 * EventSource 的 error 事件不带 HTTP 状态码，无法直接看出是不是 401。
 * 所以出错时顺手探一次鉴权（节流），401 才退回配对，网络抖动则交给 EventSource 自动重连。
 */
async function probeAuth(activeToken: string): Promise<void> {
  const now = Date.now()
  if (now - authProbeAt < AUTH_PROBE_THROTTLE_MS) return
  authProbeAt = now
  try {
    await fetchPackage(useLanSyncClientState.getState().baseUrl, activeToken)
  } catch (error) {
    if (isLanSyncAuthError(error)) {
      handleAuthRevoked()
    }
  }
}

function ensureSubscription(activeToken: string): void {
  closeSubscription()
  const baseUrl = useLanSyncClientState.getState().baseUrl
  setState({ connecting: true, connected: false })

  subscription = subscribePackageEvents(baseUrl, activeToken, {
    onReady: (info) => {
      clearReadyTimer()
      setState({
        connecting: false,
        connected: true,
        peerName: info.deviceName || useLanSyncClientState.getState().peerName,
      })
      // 首次连接 + 每次断线重连后都补拉一次，补齐离线期间电脑端推的包（需求 2 的「对齐」）。
      void pullAndApply(activeToken, '已连接').catch((error) => {
        if (isLanSyncAuthError(error)) {
          handleAuthRevoked()
        } else {
          setState({ notice: { type: 'error', text: errorText(error) } })
        }
      })
    },
    onPackage: (notice) => {
      void pullAndApply(activeToken, `收到推送（${notice.mode === 'full' ? '全量' : '增量'}）`).catch((error) => {
        if (isLanSyncAuthError(error)) {
          handleAuthRevoked()
        } else {
          setState({ notice: { type: 'error', text: errorText(error) } })
        }
      })
    },
    onRevoke: () => handleAuthRevoked(),
    onError: () => {
      setState({ connected: false, connecting: false })
      void probeAuth(activeToken)
    },
  })

  readyTimer = setTimeout(() => {
    if (useLanSyncClientState.getState().connecting) {
      setState({
        connecting: false,
        notice: {
          type: 'error',
          text: '未能建立实时连接（电脑端可能没在线，或浏览器 / 网络拦截了长连接）。普通请求能通、但这条连接不通时，同步不会实时生效。',
        },
      })
    }
  }, READY_TIMEOUT_MS)
}

/** 页面打开时静默重连（有令牌才连），失败只给一条温和提示，不打扰用户。 */
async function autoReconnect(baseUrl: string, token: string): Promise<void> {
  try {
    const info = await fetchServerInfo(baseUrl)
    setState({ peerName: info.deviceName })
    ensureSubscription(token)
  } catch {
    setState({
      connecting: false,
      notice: {
        type: 'info',
        text: '暂时连不上电脑端（可能没开机、没启动同步服务或不在同一网络），可稍后手动连接',
      },
    })
  }
}

/** 手动连接：没有令牌就走配对码握手，有令牌就直接连。 */
export async function connectLanSyncClient(input: { baseUrl: string; code?: string }): Promise<void> {
  if (!isLanSyncClientAvailable()) return
  const normalized = normalizeBaseUrl(input.baseUrl)
  if (!normalized) {
    setState({ notice: { type: 'error', text: '请填写电脑端地址' } })
    return
  }
  setState({ baseUrl: normalized, connecting: true, notice: null })
  try {
    const info = await fetchServerInfo(normalized)
    let activeToken = useLanSyncClientState.getState().token
    if (!activeToken) {
      const code = (input.code || '').trim()
      if (!code) {
        throw new Error(`已找到电脑「${info.deviceName}」，请输入它显示的 6 位配对码`)
      }
      const result = await handshake(normalized, code)
      activeToken = result.token
      persistToken(activeToken)
      setState({ token: activeToken })
    }
    persistUrl(normalized)
    setState({ peerName: info.deviceName })
    ensureSubscription(activeToken)
  } catch (error) {
    setState({ connecting: false, connected: false, notice: { type: 'error', text: errorText(error) } })
  }
}

export function disconnectLanSyncClient(): void {
  closeSubscription()
  setState({ connected: false, connecting: false, notice: { type: 'info', text: '已断开' } })
}

export function rePairLanSyncClient(): void {
  closeSubscription()
  clearStoredToken()
  setState({ token: '', connected: false, connecting: false, notice: { type: 'info', text: '已清除本机令牌，请重新输入配对码连接' } })
}

export function setLanSyncClientBaseUrl(url: string): void {
  setState({ baseUrl: url })
}

/**
 * 需求 2：把在「电脑端会话」里输入的消息转发回电脑端，由电脑端真正发送。
 * 没配对 / 没连上时**抛错**，绝不退回本地发送：那类会话的回复会随后被同步覆盖，
 * 而且它们本来就可能依赖电脑端的 MCP 等工具。
 */
export async function forwardLanSyncMessage(message: { sessionId: string; text: string }): Promise<void> {
  if (!isLanSyncClientAvailable()) {
    throw new Error('当前环境不支持转发到电脑端')
  }
  const { baseUrl, token } = useLanSyncClientState.getState()
  if (!token) {
    throw new Error('尚未与电脑端配对，请先在设置里连接电脑端')
  }
  await forwardMessageToDesktop(baseUrl, token, message)
}

/**
 * 应用级初始化：在 renderer 启动时调用一次（见 index.tsx），与设置面板是否打开无关。
 * 桌面端直接跳过（桌面端是服务端，不需要当客户端）。
 */
export function initLanSyncClient(): void {
  if (initialized) return
  initialized = true
  if (!isLanSyncClientAvailable()) return
  const baseUrl = readStoredUrl()
  const token = readStoredToken()
  setState({ baseUrl, token })
  if (!token) return
  void autoReconnect(baseUrl, token)
}
