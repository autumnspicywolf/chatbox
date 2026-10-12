// @vitest-environment jsdom
/**
 * 第 21 轮：任务完成提示音的单元测试。
 *
 * 只测「该不该响」「该响多久」这条判定链（去重、基线、工作模式、开关、时长夹取），
 * 不测真实音频输出 —— 用一个假的 AudioContext 数 start() 被叫了几次（每遍「叮咚」= 2 次）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsState = vi.hoisted(() => ({ soundOnTaskComplete: true, soundOnTaskCompleteDuration: 1 }))
const sessionLookup = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('@/settings-runtime', () => ({
  settingsStore: {
    getState: () => ({
      soundOnTaskComplete: settingsState.soundOnTaskComplete,
      soundOnTaskCompleteDuration: settingsState.soundOnTaskCompleteDuration,
    }),
  },
}))

vi.mock('@/app/renderer-application', () => ({
  rendererApplication: {
    sessionQueryBridge: {
      getSession: async () => sessionLookup.current,
    },
  },
}))

vi.mock('@/stores/session/agent-mode', () => ({
  getSessionAgentModeEntry: (_sessionId: string, session: { settings?: { agentMode?: { value?: string } } } | null) => ({
    value: session?.settings?.agentMode?.value ?? 'off',
  }),
}))

const startedTones = vi.hoisted(() => ({ count: 0 }))

class FakeAudioParam {
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class FakeNode {
  connect() {}
}

class FakeOscillator extends FakeNode {
  type = 'sine'
  frequency = new FakeAudioParam()
  start() {
    startedTones.count += 1
  }
  stop() {}
}

class FakeGain extends FakeNode {
  gain = new FakeAudioParam()
}

class FakeAudioContext {
  state = 'running'
  currentTime = 0
  destination = new FakeNode()
  createOscillator() {
    return new FakeOscillator()
  }
  createGain() {
    return new FakeGain()
  }
  resume() {
    return Promise.resolve()
  }
}

import {
  DEFAULT_TASK_COMPLETE_SOUND_SECONDS,
  MAX_TASK_COMPLETE_SOUND_SECONDS,
  MIN_TASK_COMPLETE_SOUND_SECONDS,
  notifyTaskCompleteSound,
  playLanSyncTaskCompleteSounds,
  playTaskCompleteSound,
} from '@/stores/task-complete-sound'

function assistantMessage(id: string, finishReason = 'stop') {
  return {
    id,
    role: 'assistant',
    contentParts: [{ type: 'text', text: 'done' }],
    generating: false,
    finishReason,
  }
}

function sessionEntry(id: string, agentMode: string, messageIds: string[]) {
  return {
    id,
    settings: { agentMode: { value: agentMode } },
    messages: messageIds.map((messageId) => assistantMessage(messageId)),
  }
}

function entriesFor(...sessions: Array<{ id: string }>) {
  const entries: Record<string, unknown> = {}
  for (const session of sessions) entries[`session:${session.id}`] = session
  return entries
}

describe('task-complete-sound', () => {
  beforeEach(() => {
    ;(window as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext
    settingsState.soundOnTaskComplete = true
    settingsState.soundOnTaskCompleteDuration = 1
    startedTones.count = 0
    localStorage.clear()
  })

  it('playTaskCompleteSound 合成两个音（叮、咚）', () => {
    playTaskCompleteSound()
    expect(startedTones.count).toBe(2)
  })

  it('时长=秒数：每遍「叮咚」两个音，3 秒就是三遍（6 个音）', () => {
    playTaskCompleteSound(3)
    expect(startedTones.count).toBe(6)
  })

  it('时长夹到 1–10 秒：越界与非法值都收敛到范围内', () => {
    playTaskCompleteSound(MAX_TASK_COMPLETE_SOUND_SECONDS + 20) // 30 -> 10 秒 = 20 个音
    expect(startedTones.count).toBe(MAX_TASK_COMPLETE_SOUND_SECONDS * 2)

    startedTones.count = 0
    playTaskCompleteSound(0) // 夹到 1 秒 = 2 个音
    expect(startedTones.count).toBe(MIN_TASK_COMPLETE_SOUND_SECONDS * 2)

    startedTones.count = 0
    playTaskCompleteSound(Number.NaN) // 非法值退到下限 1 秒
    expect(startedTones.count).toBe(2)
  })

  it('默认时长常量为 3 秒', () => {
    expect(DEFAULT_TASK_COMPLETE_SOUND_SECONDS).toBe(3)
  })

  it('开关关闭时一声不响', () => {
    settingsState.soundOnTaskComplete = false
    playTaskCompleteSound() // 合成层不受开关影响（由上层 gate）
    startedTones.count = 0
    playLanSyncTaskCompleteSounds(entriesFor(sessionEntry('work', 'on', ['m1'])))
    playLanSyncTaskCompleteSounds(entriesFor(sessionEntry('work', 'on', ['m1']))) // 已登记
    expect(startedTones.count).toBe(0)
  })

  it('首次同步到某会话：只登记不响（避免首次全量同步响成一片）', () => {
    playLanSyncTaskCompleteSounds(entriesFor(sessionEntry('work', 'on', ['m1', 'm2'])))
    expect(startedTones.count).toBe(0)
  })

  it('已见过的会话带回新的已完成工作模式任务：响一次', () => {
    playLanSyncTaskCompleteSounds(entriesFor(sessionEntry('work', 'on', ['m1']))) // 基线
    startedTones.count = 0
    playLanSyncTaskCompleteSounds(entriesFor(sessionEntry('work', 'on', ['m1', 'm2'])))
    expect(startedTones.count).toBe(2)
  })

  it('时长设置生效：手机端一次完成的提示音按设置重复', () => {
    settingsState.soundOnTaskCompleteDuration = 3
    playLanSyncTaskCompleteSounds(entriesFor(sessionEntry('work', 'on', ['m1']))) // 基线
    startedTones.count = 0
    playLanSyncTaskCompleteSounds(entriesFor(sessionEntry('work', 'on', ['m1', 'm2'])))
    expect(startedTones.count).toBe(6)
  })

  it('同一个包反复同步不会重复响', () => {
    playLanSyncTaskCompleteSounds(entriesFor(sessionEntry('work', 'on', ['m1']))) // 基线
    startedTones.count = 0
    const withNew = entriesFor(sessionEntry('work', 'on', ['m1', 'm2']))
    playLanSyncTaskCompleteSounds(withNew)
    expect(startedTones.count).toBe(2)
    startedTones.count = 0
    playLanSyncTaskCompleteSounds(withNew) // 再同步一次同一内容
    expect(startedTones.count).toBe(0)
  })

  it('普通（非工作模式）会话带回新消息不响', () => {
    playLanSyncTaskCompleteSounds(entriesFor(sessionEntry('chat', 'off', ['c1']))) // 基线
    startedTones.count = 0
    playLanSyncTaskCompleteSounds(entriesFor(sessionEntry('chat', 'off', ['c1', 'c2'])))
    expect(startedTones.count).toBe(0)
  })

  it('桌面端：工作模式任务完成才响，chat 模式与失败回复都不响', async () => {
    sessionLookup.current = { id: 'a', settings: { agentMode: { value: 'on' } } }
    notifyTaskCompleteSound('a', assistantMessage('m1') as never)
    await vi.waitFor(() => expect(startedTones.count).toBe(2))

    startedTones.count = 0
    settingsState.soundOnTaskCompleteDuration = 5
    notifyTaskCompleteSound('a', assistantMessage('m1b') as never)
    await vi.waitFor(() => expect(startedTones.count).toBe(10)) // 5 秒 = 五遍「叮咚」
    settingsState.soundOnTaskCompleteDuration = 1

    startedTones.count = 0
    sessionLookup.current = { id: 'b', settings: { agentMode: { value: 'off' } } }
    notifyTaskCompleteSound('b', assistantMessage('m2') as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(startedTones.count).toBe(0)

    sessionLookup.current = { id: 'c', settings: { agentMode: { value: 'on' } } }
    notifyTaskCompleteSound('c', { ...assistantMessage('m3'), generating: true } as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(startedTones.count).toBe(0)
  })

  it('桌面端：开关关闭时不响', async () => {
    settingsState.soundOnTaskComplete = false
    sessionLookup.current = { id: 'a', settings: { agentMode: { value: 'on' } } }
    notifyTaskCompleteSound('a', assistantMessage('m1') as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(startedTones.count).toBe(0)
  })
})
