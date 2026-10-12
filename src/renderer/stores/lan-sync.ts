/**
 * 桌面端「局域网同步」自动化（需求 1 / 2）。
 *
 * 三件事：
 * 1. **状态轮询**：每 STATUS_POLL_MS 问一次主进程 `lan-sync:status`，侧边栏据此显示
 *    「手机已连接 / 等待手机连接」并决定同步按钮能不能点。提示走 5s，比同步快，
 *    免得「刚连上还要等半分钟才亮灯」。
 * 2. **脏标记**：订阅 rendererApplication.sessionEvents，会话增 / 改 / 删只把一个布尔置 true。
 *    ⚠️ 绝不能在事件回调里直接推送 —— 流式回复期间 `session-updated` 是高频事件，
 *    会打爆 buildLanSyncPackage。
 * 3. **自动推送**：每 AUTO_SYNC_INTERVAL_MS 检查一次，只要「服务在跑 + 有脏标记」就推
 *    —— 不再要求「手机在线」。包会缓存在电脑端，手机下次上线（含离线期间积压的改动）
 *    会自己拉一次补齐（见 stores/lan-sync-client.ts 的 onReady 补拉），所以这里只管把
 *    最新状态灌进缓存；实时性交给 SSE 通知。推送走 pushLanSync()，与设置页「一键推送」
 *    共用同一段（build → publish → commitLanSyncManifest），否则增量基准会错乱。
 *
 * 只在 platform.type === 'desktop' 下工作；web / 手机端调用一律变 no-op。
 */
import {
  type LanSyncForwardedMessage,
  LanSyncIpcChannel,
  type LanSyncPublishResult,
  type LanSyncServerStatus,
} from '@shared/lan-sync/protocol'
import { create } from 'zustand'
import { rendererApplication } from '@/app/renderer-application'
import { buildLanSyncPackage, commitLanSyncManifest } from '@/packages/lan-sync/package-builder'
import platform from '@/platform'
import * as toastActions from '@/stores/toastActions'

/** 「手机已连接」提示的刷新间隔。 */
export const LAN_SYNC_STATUS_POLL_MS = 5_000
/**
 * 自动推送的检查间隔。
 *
 * 第 28 轮（用户拍板）：30s → 3s。口径是「不纠结任务链有没有跑完，每 3 秒检查一次、
 * 有脏标记就同步」，所以原先挂在「回复生成完成」回调上的即时推送被撤掉了 —— 3s 的
 * tick 本身就是那个即时性来源，多留一条通路只会让推送时机更难解释。
 *
 * 注意这只是「检查」：服务没跑 / 没有脏标记 / 正在推送都会直接跳过（见 autoSyncTick），
 * 所以空转时一秒钟也只做三次布尔判断，不会反复 build 同步包。
 */
export const LAN_SYNC_AUTO_SYNC_MS = 3_000

interface LanSyncAutoState {
  /** 主进程服务状态；null = 还没问到（一般是主进程没起或没启服务）。 */
  status: LanSyncServerStatus | null
  /** PC 有新会话改动的「信息更新」标记（需求 2）。 */
  dirty: boolean
  /** 正在推送（手动或自动），用于禁用按钮。 */
  syncing: boolean
  /** 最近一次成功推送的时间戳。 */
  lastSyncAt: number | null
  /** 最近一次失败原因。 */
  lastError: string | null
  /**
   * 下一次自动同步的时刻（第 24 轮：侧边栏的倒计时圈据此绘制）。
   * null = 自动同步没在跑（非桌面端，或还没调用 startLanSyncAutoSync）。
   */
  nextSyncAt: number | null
}

export const useLanSyncState = create<LanSyncAutoState>(() => ({
  status: null,
  dirty: false,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  nextSyncAt: null,
}))

/** 侧边栏读这个判断是否渲染（桌面端才有局域网同步）。 */
export function isLanSyncAvailable(): boolean {
  return platform.type === 'desktop'
}

async function invokeLanSync<T>(channel: string, payload?: unknown): Promise<T> {
  const api = window.electronAPI
  if (!api?.invoke) throw new Error('当前环境没有桌面端 IPC')
  return (await api.invoke(channel, payload)) as T
}

/** 拉一次主进程状态（幂等、失败静默：主进程没起不该刷屏报错）。 */
export async function refreshLanSyncStatus(): Promise<LanSyncServerStatus | null> {
  if (!isLanSyncAvailable()) return null
  try {
    const status = await invokeLanSync<LanSyncServerStatus>(LanSyncIpcChannel.Status)
    useLanSyncState.setState({ status })
    return status
  } catch {
    return null
  }
}

/** 会话有改动 —— 只置标记，不推送。 */
export function markLanSyncDirty(): void {
  if (!useLanSyncState.getState().dirty) {
    useLanSyncState.setState({ dirty: true })
  }
}

export interface LanSyncPushOutcome {
  ok: boolean
  /** true = 没有变化，什么都没推（不算失败）。 */
  unchanged?: boolean
  sessionCount?: number
  changedCount?: number
  bytes?: number
  error?: string
}

/**
 * 推一次（手动按钮与自动同步共用）。
 * 返回体给 UI 显示用；失败不抛，写进 lastError。
 */
export async function pushLanSync(mode: 'full' | 'incremental' = 'incremental'): Promise<LanSyncPushOutcome> {
  if (!isLanSyncAvailable()) return { ok: false, error: '当前环境不支持' }
  const state = useLanSyncState.getState()
  if (state.syncing) return { ok: false, error: '正在同步中' }

  useLanSyncState.setState({ syncing: true, lastError: null })
  try {
    // 归档会话不进同步包（镜像语义，不给开关）。动态 import 免得启动时拽进整个 session 依赖。
    const { getMetaStorage } = await import('@/stores/sessionHelpers')
    const archived = await (await getMetaStorage()).getArchived()
    const built = await buildLanSyncPackage({
      mode,
      deviceName: state.status?.deviceName || 'Chatbox',
      excludedSessionIds: new Set(archived.filter((meta) => meta.recoveryArchived !== true).map((meta) => meta.id)),
    })
    if (built.unchanged) {
      // 没变化也要落脏标记，否则每个 tick 都会重新 build 一遍
      useLanSyncState.setState({ syncing: false, dirty: false, lastSyncAt: Date.now() })
      return { ok: true, unchanged: true, sessionCount: built.sessionCount, changedCount: 0 }
    }
    const result = await invokeLanSync<LanSyncPublishResult>(LanSyncIpcChannel.Publish, {
      mode: built.mode,
      manifest: built.manifest,
      entries: built.entries,
    })
    if (!result.ok) throw new Error(result.error || '推送失败')
    commitLanSyncManifest(built.manifest)
    useLanSyncState.setState({ syncing: false, dirty: false, lastSyncAt: Date.now(), lastError: null })
    await refreshLanSyncStatus()
    return {
      ok: true,
      unchanged: false,
      sessionCount: result.sessionCount,
      changedCount: built.changedCount,
      bytes: result.bytes,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    useLanSyncState.setState({ syncing: false, lastError: message })
    return { ok: false, error: message }
  }
}

/**
 * 自动同步的一个 tick：服务在跑 + 有更新就推（需求 2 的「无更新则不触发」）。
 * 第 19 轮去掉「手机必须在线」这一条：手机端页面一关就没有 SSE，若继续以「在线」为前置，
 * 同步会退化成「必须把手机钉在设置页上」。现在无论手机在不在，都把最新包推给电脑端缓存，
 * 手机下次上线时自行拉齐 —— 实时靠 SSE 通知，最终一致靠上线补拉。
 */
async function autoSyncTick(): Promise<void> {
  const { status, dirty, syncing } = useLanSyncState.getState()
  if (syncing) return
  if (!status?.running) return
  if (!dirty) return
  await pushLanSync('incremental')
}

/**
 * 第 20 轮（需求 2）：手机端在「电脑端会话」里输入的消息转发回来，由这里真正发送。
 *
 * 为什么不让手机自己发：那类会话本来就诞生在电脑端，可能依赖电脑端的 MCP 等工具；
 * 而且手机本地生成的回复会在下一次同步里被电脑端的版本覆盖。统一在电脑端发送后，
 * 会话变更会照常触发自动推送，回复再同步回手机 —— 闭环。
 *
 * 动态 import 两个重依赖，避免 lan-sync 在启动时就把整个 session store 拽进来。
 */
async function handleForwardedMessage(message: LanSyncForwardedMessage): Promise<void> {
  try {
    const [{ submitNewUserMessage }, { createMessage }] = await Promise.all([
      import('@/stores/session/messages'),
      import('@shared/types'),
    ])
    const session = await rendererApplication.sessionQueryBridge.getSession(message.sessionId)
    if (!session) {
      toastActions.add('手机转发的消息对应会话不存在，可能已在电脑端删除')
      return
    }
    await submitNewUserMessage(message.sessionId, {
      newUserMsg: createMessage('user', message.text),
      needGenerating: true,
    })
    // 回复已生成完（submitNewUserMessage 会 await 完整生成），立刻回推一次，
    // 手机端就不必等下一次 30s 自动 tick 才看到回复。
    void pushLanSync()
    toastActions.add('已收到手机转发的消息，并在电脑端发送')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[lan-sync] 处理手机转发的消息失败：', error)
    toastActions.add(`处理手机转发的消息失败：${detail}`)
  }
}

let refCount = 0
let teardown: (() => void) | null = null

function install(): () => void {
  const unsubscribe = rendererApplication.sessionEvents.subscribe((event) => {
    // session-will-delete 后面必然跟 session-deleted，只看后者即可；
    // session-list-reset 是缓存投影刷新（启动时也会触发），不代表数据变了。
    if (event.type === 'session-created' || event.type === 'session-updated' || event.type === 'session-deleted') {
      markLanSyncDirty()
    }
  })
  // 需求 2：接住主进程推送的「手机转发消息」，真正在电脑端发送。
  const offForward = window.electronAPI?.onLanSyncForwardedMessage?.((message) => {
    void handleForwardedMessage(message)
  })
  void refreshLanSyncStatus()
  const statusTimer = setInterval(() => {
    void refreshLanSyncStatus()
  }, LAN_SYNC_STATUS_POLL_MS)
  // 第 24 轮：把「下一次自动同步的时刻」写进 store，侧边栏据此画倒计时圈。
  // 时间戳在每次 tick 刚进来时就算好（而不是等推送跑完），所以圈转满的那一刻
  // 正好是 autoSyncTick 开跑的那一刻 ——「倒计时转完 = 自动同步」在视觉上对得上。
  useLanSyncState.setState({ nextSyncAt: Date.now() + LAN_SYNC_AUTO_SYNC_MS })
  const syncTimer = setInterval(() => {
    useLanSyncState.setState({ nextSyncAt: Date.now() + LAN_SYNC_AUTO_SYNC_MS })
    void autoSyncTick()
  }, LAN_SYNC_AUTO_SYNC_MS)
  return () => {
    unsubscribe()
    offForward?.()
    clearInterval(statusTimer)
    clearInterval(syncTimer)
  }
}

/**
 * 启动轮询与自动同步，返回清理函数。引用计数，多次调用只装一次
 * （React StrictMode 的 mount → unmount → mount 也安全）。
 */
export function startLanSyncAutoSync(): () => void {
  if (!isLanSyncAvailable()) return () => {}
  refCount += 1
  if (refCount === 1) teardown = install()
  return () => {
    refCount -= 1
    if (refCount <= 0) {
      refCount = 0
      teardown?.()
      teardown = null
      useLanSyncState.setState({ status: null, dirty: false, syncing: false, nextSyncAt: null })
    }
  }
}
