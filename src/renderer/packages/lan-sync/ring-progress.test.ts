/**
 * 第 24 轮：自动同步倒计时圈的进度计算单测。
 *
 * 纯函数，喂固定时间戳，不依赖 DOM / store / 计时器。
 */
import { describe, expect, it } from 'vitest'
import { lanSyncRingProgress } from './ring-progress'

const INTERVAL = 30_000
const T0 = 1_700_000_000_000

describe('lanSyncRingProgress', () => {
  it('没有下一次同步时刻时：不除零，显示整段秒数、进度 0', () => {
    expect(lanSyncRingProgress(null, { now: T0, intervalMs: INTERVAL })).toEqual({ seconds: 30, progress: 0 })
  })

  it('刚重置：进度 0、剩余整段秒数', () => {
    expect(lanSyncRingProgress(T0 + INTERVAL, { now: T0, intervalMs: INTERVAL })).toEqual({
      seconds: 30,
      progress: 0,
    })
  })

  it('过半：进度 0.5、剩 15 秒', () => {
    const result = lanSyncRingProgress(T0 + INTERVAL, { now: T0 + 15_000, intervalMs: INTERVAL })
    expect(result.progress).toBeCloseTo(0.5, 6)
    expect(result.seconds).toBe(15)
  })

  it('到点：进度 1、剩 0 秒（此刻自动同步开跑）', () => {
    expect(lanSyncRingProgress(T0 + INTERVAL, { now: T0 + INTERVAL, intervalMs: INTERVAL })).toEqual({
      seconds: 0,
      progress: 1,
    })
  })

  it('过点：进度与秒数都夹在边界，不出现负数', () => {
    const result = lanSyncRingProgress(T0 + INTERVAL, { now: T0 + INTERVAL + 500, intervalMs: INTERVAL })
    expect(result.progress).toBe(1)
    expect(result.seconds).toBe(0)
  })

  it('不足一秒：秒数向上取整（不会提前停在 0 秒）', () => {
    const result = lanSyncRingProgress(T0 + INTERVAL, { now: T0 + INTERVAL - 200, intervalMs: INTERVAL })
    expect(result.seconds).toBe(1)
    expect(result.progress).toBeGreaterThan(0.99)
  })

  it('intervalMs 非法：不除零，退化成静态满圈秒数', () => {
    expect(lanSyncRingProgress(T0 + INTERVAL, { now: T0, intervalMs: 0 })).toEqual({ seconds: 0, progress: 0 })
  })
})
