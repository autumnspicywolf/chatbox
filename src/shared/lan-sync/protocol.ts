/**
 * 局域网同步协议：主进程（服务端 / 哑管道）与 renderer（数据源 / 客户端）共用。
 *
 * 设计要点
 * - 主进程只做「哑管道」：起 HTTP + SSE 服务、缓存最近一次同步包，不碰会话数据本身。
 *   会话数据在 renderer 的存储里（桌面端是 renderer 侧 localforage/IndexedDB，
 *   主进程的 electron-store 只放 configs/settings/configVersion，见 desktop_platform.ts 的 needStoreInFile）。
 * - 同步包里的 entries 是**原样的 store 键值对**（`session:<id>` / `chat-sessions-list` ……），
 *   对端直接 setAllStoreValues 落地即可，无需理解会话结构 —— 这正是平台抽象层带来的好处。
 * - 指纹是纯 JS 实现，不用 crypto.subtle：局域网 http（http://192.168.x.x）不是安全上下文，
 *   实测 crypto.subtle === undefined，备份模块的 sha256 在那里会直接抛错。
 */

export const LAN_SYNC_PROTOCOL_VERSION = 1

/** 默认监听端口。避开 1212（vite dev server）与 8899（本机镜像代理）。 */
export const LAN_SYNC_DEFAULT_PORT = 17878

/** 主进程 <-> renderer 的 IPC 通道。 */
export const LanSyncIpcChannel = {
  Start: 'lan-sync:start',
  Stop: 'lan-sync:stop',
  Publish: 'lan-sync:publish',
  Status: 'lan-sync:status',
  /** 重新生成配对码 + 令牌（换手机 / 解除配对用），见需求 5。 */
  Rotate: 'lan-sync:rotate',
} as const

/** 手机端用到的 HTTP 路由。 */
export const LanSyncHttpPath = {
  Info: '/lan-sync/info',
  Handshake: '/lan-sync/handshake',
  Package: '/lan-sync/package',
  Events: '/lan-sync/events',
  /**
   * 第 20 轮：手机端把「本该在电脑端进行的会话」里输入的消息转发回来，
   * 由电脑端真正发送（会话可能依赖电脑端的 MCP 等工具）。
   */
  Forward: '/lan-sync/forward',
} as const

/**
 * 主进程 → renderer 的**单向推送**通道（renderer 用 electronAPI 订阅，
 * 不是 invoke）。与 LanSyncIpcChannel 分开，避免和 invoke 方向混在一起。
 */
export const LanSyncPushChannel = {
  /** 手机端转发过来、由主进程转交给 renderer 真正发送的用户消息。 */
  ForwardedMessage: 'lan-sync:forwarded-message',
} as const

/** 手机端 → 电脑端转发的一条用户消息。 */
export interface LanSyncForwardedMessage {
  sessionId: string
  /** 用户输入的纯文本（第一版只转发文本，不带附件）。 */
  text: string
  /** 手机端发起的时刻（e.g. 用于去重 / 显示）。 */
  at: number
}

/** 清单里的单条会话。fingerprint 由 PC 端计算，手机端只比对，不自己算。 */
export interface LanSyncSessionEntry {
  id: string
  name: string
  fingerprint: string
  updatedAt?: number
}

export interface LanSyncManifest {
  deviceName: string
  generatedAt: number
  sessions: LanSyncSessionEntry[]
}

/**
 * 一次「一键推送」产出的同步包。
 * mode='full' 表示对端应把自己这边的会话清空后按本包重建（真镜像）；
 * mode='incremental' 表示只覆盖 entries 里出现的会话。
 */
export interface LanSyncPackage {
  protocolVersion: number
  batchId: string
  deviceName: string
  generatedAt: number
  mode: 'full' | 'incremental'
  manifest: LanSyncManifest
  /** 原样的 store 键值对，对端 setAllStoreValues 落地 */
  entries: Record<string, unknown>
  sessionCount: number
  bytes: number
}

export interface LanSyncServerStatus {
  running: boolean
  port: number
  /** 可用访问地址（http://<局域网IP>:<port>） */
  urls: string[]
  deviceName: string
  /** 一次性配对码，手机端首次连接要输入 */
  pairingCode: string
  connectedClients: number
  hasPackage: boolean
  lastBatchId?: string
  lastBatchMode?: 'full' | 'incremental'
  lastPublishAt?: number
  lastSessionCount?: number
  lastBytes?: number
}

export interface LanSyncStartResult {
  ok: boolean
  status?: LanSyncServerStatus
  error?: string
}

/** 持久化在 electron-store 里的配对凭证（需求 5：配对码一次配对后不再变）。 */
export interface LanSyncCredentials {
  pairingCode: string
  token: string
}

export interface LanSyncPublishResult {
  ok: boolean
  batchId?: string
  mode?: 'full' | 'incremental'
  sessionCount?: number
  bytes?: number
  error?: string
}

/**
 * 纯 JS 指纹：双通道 FNV-1a（32 位）拼成 64 位 hex。
 * 稳定、零依赖、双端一致，且不需要安全上下文。
 */
export function lanSyncFingerprint(input: string): string {
  let h1 = 0x81_1c_9d_c5
  let h2 = 0x01_00_01_93
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01_00_01_93) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85_eb_ca_6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}
