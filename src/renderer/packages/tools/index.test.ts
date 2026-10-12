import { describe, expect, it, vi } from 'vitest'

vi.mock('i18next', () => ({ t: (key: string) => key }))

import { getToolName } from './index'

describe('getToolName', () => {
  it('localizes current and legacy command tools', () => {
    expect(getToolName('run_command')).toBe('Run Command')
    expect(getToolName('user_exec')).toBe('Run Command')
  })

  it('prefers the model-provided description for run_command / user_exec', () => {
    expect(getToolName('run_command', { command: 'type main.log', description: '查看 main.log' })).toBe('查看 main.log')
    expect(getToolName('user_exec', { description: '运行绿色包' })).toBe('运行绿色包')
  })

  it('falls back to the tool name when the command description is missing or blank', () => {
    expect(getToolName('run_command', { command: 'type main.log' })).toBe('Run Command')
    expect(getToolName('run_command', { command: 'type main.log', description: '   ' })).toBe('Run Command')
    expect(getToolName('run_command', { command: 'type main.log', description: 42 })).toBe('Run Command')
  })

  it.each([
    [{ argv: ['version'] }, 'Chatbox Version'],
    [{ argv: ['account', 'status'] }, 'Account Status'],
    [{ argv: ['account', 'license'] }, 'License Details'],
    [{ argv: ['account', 'quota'] }, 'Quota Details'],
    [{ argv: ['account', 'refresh'] }, 'Refresh Account Status'],
    [{ argv: ['settings', 'list'] }, 'List Settings'],
    [{ command: 'chatbox settings get appearance.theme' }, 'Read Setting'],
    [{ argv: ['chats', 'list', '--limit', '10'] }, 'Conversation List'],
    [{ argv: ['chats', 'search', 'release notes'] }, 'Search All Conversations'],
    [{ argv: ['chats', 'read', 'session-1'] }, 'Read Conversation'],
    [{ argv: ['image', 'models'] }, 'List Image Models'],
    [{ command: 'chatbox image generate --prompt "a red fox"' }, 'Generate images'],
    [{ argv: ['image', 'status', 'record-1'] }, 'Image Generation Status'],
    [{ argv: ['image', 'history'] }, 'Image History'],
  ])('shows a command-specific Chatbox CLI name for %j', (input, expected) => {
    expect(getToolName('chatbox_cli', input)).toBe(expected)
  })

  it('supports legacy account aliases and safe fallback names', () => {
    expect(getToolName('chatbox_cli', { argv: ['quota'] })).toBe('Quota Details')
    expect(getToolName('chatbox_cli', { argv: ['license', 'refresh'] })).toBe('Refresh Account Status')
    expect(getToolName('chatbox_cli', { argv: ['help'] })).toBe('Chatbox')
    expect(getToolName('chatbox_cli', { command: '"unterminated' })).toBe('Chatbox')
  })
})
