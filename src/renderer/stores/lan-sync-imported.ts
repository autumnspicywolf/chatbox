/**
 * 「这条会话是从电脑端同步过来的」标记（第 20 轮，需求 1 / 2）。
 *
 * 只存在于客户端（web / 手机端）：
 * - 需求 1：会话列表里给这些会话的名字后面加一个电脑图标。
 * - 需求 2：在这些会话里输入的消息不本地发送，而是转发回电脑端，由电脑端真正发送
 *   （会话可能依赖电脑端的 MCP 等工具），避免本地生成的回复被随后的同步覆盖。
 *
 * 为什么不写进会话数据里：会话数据是「电脑端推什么就是什么」的原样 store 键值对，
 * 往里塞字段会污染与电脑端的一致性；而这份标记只对手机端有意义，所以单独存 localStorage，
 * 且是**只增不减**的累积集合（增量包只带变更过的会话，累积集合才不会漏标）。
 */
import { create } from 'zustand'

/** 已同步会话 id 集合的存储键。 */
export const LAN_SYNC_IMPORTED_SESSIONS_KEY = 'lan-sync:client:imported-sessions'

function readStoredIds(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(LAN_SYNC_IMPORTED_SESSIONS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function persistIds(ids: string[]): void {
  try {
    globalThis.localStorage?.setItem(LAN_SYNC_IMPORTED_SESSIONS_KEY, JSON.stringify(ids))
  } catch {
    // 隐私模式等写不进去也不该崩：内存里的标记本次会话仍然有效
  }
}

interface LanSyncImportedState {
  /** 用对象而不是 Set，方便 zustand 浅比较与序列化。 */
  ids: Record<string, true>
}

export const useLanSyncImportedSessions = create<LanSyncImportedState>(() => ({
  ids: Object.fromEntries(readStoredIds().map((id) => [id, true])) as Record<string, true>,
}))

/** 把一批会话标记为「来自电脑端」（applyPackage 之后调用）。 */
export function markLanSyncImportedSessions(sessionIds: string[]): void {
  if (sessionIds.length === 0) return
  const current = useLanSyncImportedSessions.getState().ids
  let changed = false
  const next: Record<string, true> = { ...current }
  for (const id of sessionIds) {
    if (id && !next[id]) {
      next[id] = true
      changed = true
    }
  }
  if (!changed) return
  useLanSyncImportedSessions.setState({ ids: next })
  persistIds(Object.keys(next))
}

/** 非 React 环境（事件回调里）判断某会话是不是来自电脑端。 */
export function isLanSyncImportedSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return Boolean(useLanSyncImportedSessions.getState().ids[sessionId])
}

/** React hook：会话是否来自电脑端。用于列表加图标 + 判断消息是否要转发。 */
export function useLanSyncImportedSession(sessionId: string | null | undefined): boolean {
  return useLanSyncImportedSessions((state) => (sessionId ? Boolean(state.ids[sessionId]) : false))
}
