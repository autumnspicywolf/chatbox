/**
 * 任务完成提示音（第 21 轮）。
 *
 * 两个触发面：
 * 1. **桌面端**：工作模式（Work Mode）下一次助手回复生成完成时响一次
 *    （挂在 `CurrentGenerationService` 的 `afterMessageGenerated` 上）。
 * 2. **手机端**（LAN 同步客户端）：增量/全量同步把「电脑端刚完成」的工作模式任务
 *    带回手机时响一次 —— 也就是用户在手机上把消息转发回电脑端、电脑端跑完推回来的那一刻。
 *
 * 声音不用任何音频资源文件，直接用 Web Audio 现场合成一个「叮—咚」两音提示
 * （先高后低、短促、带指数衰减包络）：桌面端（Electron renderer）与手机浏览器
 * （web 构建）同一套代码都能响，打包产物里也不用塞 mp3。
 *
 * 浏览器的自动播放策略要求 AudioContext 在用户交互之后才能出声；这里两条链路
 * 都发生在用户已经点过/打过字之后，真被拦下也只是静默失败，不影响功能。
 *
 * 开关：设置里的 `soundOnTaskComplete`（默认开，见 chatbox-core 的 settings-schema）。
 * 时长：设置里的 `soundOnTaskCompleteDuration`（秒，1–10，默认 3）。「叮咚」每秒重复一次，
 * 所以 3 秒就是连响三声 —— 调长一些，人离开一会儿也不容易漏听。
 */
import { resolveSessionMode } from '@chatbox/core/session/mode-policy'
import type { Message, Session } from '@shared/types'
import { rendererApplication } from '@/app/renderer-application'
import { announceLanSyncTaskComplete } from '@/packages/lan-sync/mobile-keepalive'
import { settingsStore } from '@/settings-runtime'
import { isSuccessfulAssistantReply } from '@/stores/session/message-success'
import { getSessionAgentModeEntry } from '@/stores/session/agent-mode'

// ---------------------------------------------------------------------------
// 合成「叮—咚」
// ---------------------------------------------------------------------------

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!ctor) return null
  if (!audioContext) {
    try {
      audioContext = new ctor()
    } catch {
      return null
    }
  }
  return audioContext
}

function playTone(ctx: AudioContext, frequency: number, startAt: number, duration: number, peak: number): void {
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(frequency, startAt)
  // 用 exponentialRamp 做柔和起落（起止值都不能为 0，故取 0.0001 当「静音」）。
  gain.gain.setValueAtTime(0.0001, startAt)
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
  oscillator.connect(gain)
  gain.connect(ctx.destination)
  oscillator.start(startAt)
  oscillator.stop(startAt + duration + 0.05)
}

/** 「叮」「咚」各自的时长与相对起点（秒）。 */
const DING_DURATION = 0.22
const DONG_OFFSET = 0.16
const DONG_DURATION = 0.42
/** 两遍「叮咚」之间的间隔（秒）：每秒响一次。 */
const REPEAT_INTERVAL_SECONDS = 1

/**
 * 两个音的振幅峰值（满量程 1.0）。为了「尽量最大」已顶到接近上限：
 * 「叮」稍高于「咚」保持层次。两音在时间上几乎不重叠（「咚」起音时「叮」已衰减到约 0.2%），
 * 相加峰值仍 < 1.0，所以留 5% 余量以避免任何硬削波失真后就不再往上顶。
 * 最终响度仍受设备/系统音量影响。
 */
const DING_PEAK = 0.95
const DONG_PEAK = 0.9

/** 时长设置的可调范围与默认值（秒），设置界面也用这几个常量。 */
export const MIN_TASK_COMPLETE_SOUND_SECONDS = 1
export const MAX_TASK_COMPLETE_SOUND_SECONDS = 10
export const DEFAULT_TASK_COMPLETE_SOUND_SECONDS = 3

/** 取整并夹到 [1, 10]；不是有限数就用 fallback。 */
function clampDurationSeconds(value: unknown, fallback: number): number {
  const seconds = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(MAX_TASK_COMPLETE_SOUND_SECONDS, Math.max(MIN_TASK_COMPLETE_SOUND_SECONDS, seconds))
}

/**
 * 播放「叮—咚」（B5 → E5）。
 *
 * `durationSeconds` 是总时长（秒，取整后夹到 1–10），每秒重复一遍，
 * 所以 1 秒响一次、3 秒响三次。所有音在调用时一次性排好时间轴，
 * 不依赖 setTimeout —— 页面被节流也不会漏音。
 * 任何环境 / 自动播放策略问题都静默忽略。
 */
export function playTaskCompleteSound(durationSeconds: number = MIN_TASK_COMPLETE_SOUND_SECONDS): void {
  const ctx = getAudioContext()
  if (!ctx) return
  try {
    if (ctx.state === 'suspended') void ctx.resume()
    const repeats = clampDurationSeconds(durationSeconds, MIN_TASK_COMPLETE_SOUND_SECONDS)
    const base = ctx.currentTime + 0.02
    for (let index = 0; index < repeats; index += 1) {
      const start = base + index * REPEAT_INTERVAL_SECONDS
      playTone(ctx, 987.77, start, DING_DURATION, DING_PEAK) // 叮 B5
      playTone(ctx, 659.25, start + DONG_OFFSET, DONG_DURATION, DONG_PEAK) // 咚 E5
    }
  } catch {
    // 声音不可用不该影响功能
  }
}

// ---------------------------------------------------------------------------
// 设置开关
// ---------------------------------------------------------------------------

function isSoundOnTaskCompleteEnabled(): boolean {
  try {
    // 默认开：只有显式关掉（=== false）才不响。
    return settingsStore.getState().soundOnTaskComplete !== false
  } catch {
    return true
  }
}

/** 「叮咚」该响多久（秒）：读设置里的 `soundOnTaskCompleteDuration`，越界/读不到时退回默认。 */
function soundDurationSeconds(): number {
  try {
    return clampDurationSeconds(
      settingsStore.getState().soundOnTaskCompleteDuration,
      DEFAULT_TASK_COMPLETE_SOUND_SECONDS
    )
  } catch {
    return DEFAULT_TASK_COMPLETE_SOUND_SECONDS
  }
}

// ---------------------------------------------------------------------------
// 触发面 1：桌面端 —— 工作模式任务完成
// ---------------------------------------------------------------------------

/**
 * 桌面端一条助手回复生成完成时调用（`afterMessageGenerated`）。
 * 仅当该会话处于工作模式（Work Mode）且回复确实成功时才响。
 */
export function notifyTaskCompleteSound(sessionId: string, message: Message): void {
  if (!isSuccessfulAssistantReply(message)) return
  if (!isSoundOnTaskCompleteEnabled()) return
  void (async () => {
    try {
      const session = await rendererApplication.sessionQueryBridge.getSession(sessionId)
      if (!session) return
      if (resolveSessionMode(getSessionAgentModeEntry(sessionId, session).value) !== 'work') return
      playTaskCompleteSound(soundDurationSeconds())
    } catch {
      // 查会话失败就当作不需要响
    }
  })()
}

// ---------------------------------------------------------------------------
// 触发面 2：手机端 —— 同步收到电脑端刚完成的工作模式任务
// ---------------------------------------------------------------------------

/**
 * 每个会话「会话 — 我们最后见过的那条已完成工作模式任务的助手消息 id」。
 * 只存一条/会话（而不是无限累积所有消息 id），内存有上限；会话第一次出现时只登记不响，
 * 之后这条 id 变了就说明电脑端又完成了一个任务。
 */
const LAST_COMPLETED_TASK_KEY = 'lan-sync:client:last-completed-task'

function readLastCompletedMap(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_COMPLETED_TASK_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const map: Record<string, string> = {}
    for (const [sessionId, messageId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof messageId === 'string') map[sessionId] = messageId
    }
    return map
  } catch {
    return {}
  }
}

function writeLastCompletedMap(map: Record<string, string>): void {
  try {
    globalThis.localStorage?.setItem(LAST_COMPLETED_TASK_KEY, JSON.stringify(map))
  } catch {
    // 隐私模式等写不进去也不该崩
  }
}

interface SyncedSessionLike {
  id?: unknown
  messages?: unknown
  settings?: Session['settings']
}

/** 按消息顺序返回该会话里「已成功完成的助手回复」的消息 id（最后一条就是最新完成的任务）。 */
function completedTaskMessageIds(session: SyncedSessionLike): string[] {
  const messages = Array.isArray(session.messages) ? session.messages : []
  const ids: string[] = []
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const message = raw as Message
    if (!Array.isArray(message.contentParts)) continue
    if (!isSuccessfulAssistantReply(message)) continue
    if (typeof message.id === 'string' && message.id) ids.push(message.id)
  }
  return ids
}

/**
 * 手机端应用完一个同步包后调用。
 * 对「电脑端刚完成的工作模式任务」响一次 —— 只在**已经见过的会话**上生效：
 * 某个会话第一次同步到手机上时它的历史完成消息只登记不响（否则首次全量同步会响成一片）。
 */
export function playLanSyncTaskCompleteSounds(entries: Record<string, unknown> | undefined): void {
  if (!isSoundOnTaskCompleteEnabled()) return
  const sessionEntries = Object.entries(entries || {}).filter(([key]) => key.startsWith('session:'))
  if (sessionEntries.length === 0) return

  const lastCompleted = readLastCompletedMap()
  let shouldPlay = false
  let notifyName = ''
  let changed = false

  for (const [key, rawSession] of sessionEntries) {
    if (!rawSession || typeof rawSession !== 'object') continue
    const session = rawSession as SyncedSessionLike
    const completedIds = completedTaskMessageIds(session)
    if (completedIds.length === 0) continue

    const sessionId = typeof session.id === 'string' && session.id ? session.id : key.slice('session:'.length)
    const latestId = completedIds[completedIds.length - 1]
    const seenId = lastCompleted[sessionId]

    if (seenId === undefined) {
      // 第一次见到这个会话：只登记基线，不响。
    } else if (seenId !== latestId) {
      const isWorkMode = resolveSessionMode(getSessionAgentModeEntry(sessionId, session).value) === 'work'
      if (isWorkMode) {
        shouldPlay = true
        const rawName = (session as { name?: unknown }).name
        if (typeof rawName === 'string' && rawName) notifyName = rawName
      }
    }

    if (seenId !== latestId) {
      lastCompleted[sessionId] = latestId
      changed = true
    }
  }

  if (changed) writeLastCompletedMap(lastCompleted)
  if (shouldPlay) {
    // 第 23 轮：桌面端响「叮咚」不变；Android 后台改成系统通知（见 mobile-keepalive）
    void announceLanSyncTaskComplete(notifyName, () => playTaskCompleteSound(soundDurationSeconds()))
  }
}
