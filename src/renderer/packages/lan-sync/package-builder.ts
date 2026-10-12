import { type LanSyncManifest, type LanSyncSessionEntry, lanSyncFingerprint } from '../../../shared/lan-sync/protocol'
import storage, { StorageKey } from '../../storage'

/** 会话本体在 store 里的键前缀。 */
const SESSION_KEY_PREFIX = 'session:'

/** 上一次推送的指纹基准（存在 localStorage，避免污染 settings schema）。 */
const LAST_MANIFEST_KEY = 'lan-sync:last-manifest'

/**
 * 除会话本体外一并同步的键。
 * - chat-sessions-list：会话列表，对端 UI 只看它，覆盖它就等于「镜像」了 PC 的可见会话。
 * - chat-session-settings：每个会话的模型/参数选择，不带上对端会全是默认值。
 */
function companionKeys(): string[] {
  return [StorageKey.ChatSessionsList, StorageKey.ChatSessionSettings]
}

interface LastManifest {
  fingerprints: Record<string, string>
  updatedAt: number
}

function readLastManifest(): LastManifest | null {
  try {
    const raw = localStorage.getItem(LAST_MANIFEST_KEY)
    return raw ? (JSON.parse(raw) as LastManifest) : null
  } catch {
    return null
  }
}

/** 推送成功后调用：把本次清单记为下一次增量比对的基准。 */
export function commitLanSyncManifest(manifest: LanSyncManifest): void {
  try {
    const fingerprints: Record<string, string> = {}
    manifest.sessions.forEach((session) => {
      fingerprints[session.id] = session.fingerprint
    })
    localStorage.setItem(LAST_MANIFEST_KEY, JSON.stringify({ fingerprints, updatedAt: Date.now() }))
  } catch {
    // localStorage 不可用时退化为每次都全量
  }
}

/** 清掉增量基准，下一次自动变成全量。 */
export function clearLanSyncManifest(): void {
  try {
    localStorage.removeItem(LAST_MANIFEST_KEY)
  } catch {
    // ignore
  }
}

/** 取上次推送的会话数（0 表示还没推过）。 */
export function readBaselineCount(): number {
  const last = readLastManifest()
  return last ? Object.keys(last.fingerprints).length : 0
}

function sessionEntryFromValue(id: string, value: unknown): LanSyncSessionEntry {
  const record = value as { name?: unknown; messages?: unknown } | null
  const name = record && typeof record.name === 'string' ? record.name : id
  let updatedAt: number | undefined
  if (record && Array.isArray(record.messages) && record.messages.length > 0) {
    const lastMessage = record.messages[record.messages.length - 1] as
      | { timestamp?: number; updatedAt?: number }
      | undefined
    const stamp = lastMessage?.updatedAt ?? lastMessage?.timestamp
    if (typeof stamp === 'number') {
      updatedAt = stamp
    }
  }
  return { id, name, fingerprint: lanSyncFingerprint(JSON.stringify(value)), updatedAt }
}

export interface LanSyncBuildResult {
  mode: 'full' | 'incremental'
  batchId: string
  manifest: LanSyncManifest
  entries: Record<string, unknown>
  /** 本次真正带上的会话数（增量时 = 变化的会话数） */
  changedCount: number
  /** 本机会话总数 */
  sessionCount: number
  /** 是否与上一次推送完全相同（增量且无变化） */
  unchanged: boolean
}

/**
 * 构建一份同步包。
 *
 * 数据来源是平台的 store（桌面端 = renderer 侧 localforage/IndexedDB，Web 端 = IndexedDB），
 * 这里刻意用 `getAllStoreKeys` + `getItem` 原始读写，不碰会话结构 —— 换来的好处是
 * 对端可以直接 `setAllStoreValues(entries)` 落地，两端代码都不用理解会话格式。
 */
export async function buildLanSyncPackage(options: {
  mode: 'full' | 'incremental'
  deviceName: string
  /**
   * 已归档会话的 id。同步是「镜像」不是备份：归档 == 用户不要了，
   * 所以整条不进包，手机端也就不会重建出这些会话。
   */
  excludedSessionIds?: ReadonlySet<string> | readonly string[]
}): Promise<LanSyncBuildResult> {
  const excluded =
    options.excludedSessionIds instanceof Set ? options.excludedSessionIds : new Set(options.excludedSessionIds ?? [])
  const keys = await storage.getAllKeys()
  const sessionKeys = keys
    .filter((key) => key.startsWith(SESSION_KEY_PREFIX))
    .filter((key) => !excluded.has(key.slice(SESSION_KEY_PREFIX.length)))

  const values = new Map<string, unknown>()
  const sessions: LanSyncSessionEntry[] = []
  for (const key of sessionKeys) {
    const raw = await storage.getItem<unknown>(key, null)
    if (raw === null || raw === undefined) continue
    values.set(key, raw)
    sessions.push(sessionEntryFromValue(key.slice(SESSION_KEY_PREFIX.length), raw))
  }
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

  const manifest: LanSyncManifest = {
    deviceName: options.deviceName,
    generatedAt: Date.now(),
    sessions,
  }

  const baseline = readLastManifest()
  const entries: Record<string, unknown> = {}
  let changedCount = 0
  sessions.forEach((session) => {
    const changed = options.mode === 'full' || !baseline || baseline.fingerprints[session.id] !== session.fingerprint
    if (changed) {
      entries[SESSION_KEY_PREFIX + session.id] = values.get(SESSION_KEY_PREFIX + session.id)
      changedCount += 1
    }
  })

  for (const key of companionKeys()) {
    const value = await storage.getItem<unknown>(key, null)
    if (value !== null && value !== undefined) {
      entries[key] = value
    }
  }

  return {
    mode: options.mode,
    batchId: `b${Date.now().toString(36)}`,
    manifest,
    entries,
    changedCount,
    sessionCount: sessions.length,
    unchanged: options.mode === 'incremental' && changedCount === 0,
  }
}
