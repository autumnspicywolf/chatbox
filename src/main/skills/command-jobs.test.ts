import { afterEach, describe, expect, test } from 'vitest'
import {
  __resetCommandJobsForTests,
  createCommandJob,
  disposeCommandJob,
  findCommandJobsByToolCall,
  getCommandJob,
  listCommandJobs,
} from './command-jobs'

afterEach(() => {
  __resetCommandJobsForTests()
})

describe('command job registry', () => {
  test('keeps only the tail of the recent output', () => {
    const job = createCommandJob({ command: 'x', child: null })
    job.appendOutput('stdout', Buffer.from('a'.repeat(6_000)))
    job.appendOutput('stdout', Buffer.from('b'.repeat(6_000)))
    const snapshot = job.snapshot()
    expect(snapshot.outputBytes).toBeLessThanOrEqual(8 * 1024)
    expect(snapshot.recentOutput).toBe('b'.repeat(6_000))
  })

  test('decodes multibyte characters that are split across chunks', () => {
    const job = createCommandJob({ command: 'x', child: null })
    const bytes = Buffer.from('中文输出\n')
    job.appendOutput('stdout', bytes.subarray(0, 1))
    job.appendOutput('stderr', bytes.subarray(1))
    expect(job.snapshot().recentOutput).toBe('中文输出\n')
  })

  test('wait resolves as soon as new output arrives', async () => {
    const job = createCommandJob({ command: 'x', child: null })
    const waiting = job.wait(5_000)
    setTimeout(() => job.appendOutput('stdout', Buffer.from('hello')), 20)
    await expect(waiting).resolves.toMatchObject({ reason: 'output' })
    expect((await waiting).snapshot.recentOutput).toBe('hello')
  })

  test('wait resolves on timeout when nothing happens', async () => {
    const job = createCommandJob({ command: 'x', child: null })
    await expect(job.wait(30)).resolves.toMatchObject({ reason: 'timeout' })
  })

  test('wait resolves at once when the job already exited', async () => {
    const job = createCommandJob({ command: 'x', child: null })
    job.markExited(0)
    const outcome = await job.wait(5_000)
    expect(outcome.reason).toBe('exited')
    expect(outcome.snapshot.state).toBe('exited')
    expect(outcome.snapshot.exitCode).toBe(0)
  })

  test('kill on a job with no child settles it instead of hanging', async () => {
    const job = createCommandJob({ command: 'x', child: null })
    await expect(job.kill()).resolves.toBe(false)
    expect(job.state).not.toBe('running')
  })

  test('indexes jobs by session and tool call, and disposes them', () => {
    const a = createCommandJob({ command: 'a', child: null, sessionId: 's1', toolCallId: 't1' })
    createCommandJob({ command: 'b', child: null, sessionId: 's2', toolCallId: 't2' })
    expect(
      listCommandJobs({ sessionId: 's1' })
        .map((job) => job.id)
        .sort()
    ).toEqual([a.id])
    expect(
      findCommandJobsByToolCall('s1', 't1')
        .map((job) => job.id)
        .sort()
    ).toEqual([a.id])
    expect(findCommandJobsByToolCall('s2', 't1')).toEqual([])
    expect(getCommandJob('job_missing')).toBeUndefined()
    disposeCommandJob(a.id)
    expect(getCommandJob(a.id)).toBeUndefined()
  })
})
