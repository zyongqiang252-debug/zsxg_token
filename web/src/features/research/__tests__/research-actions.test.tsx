/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { ResearchAssistant } from '../index'
import { serializeReport } from '../research-workflow'

const source = {
  id: 7,
  name: '心得.txt',
  text: '降息预期推动波动，失效条件尚未定义。',
}
beforeEach(() => {
  useAuthStore.getState().auth.setUser({ id: 1, username: 'test', role: 1 })
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: [source] },
  })
})
afterEach(() => {
  useAuthStore.getState().auth.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('summarizes selected notes, saves edits, and reopens the saved result after remount', async () => {
  const user = userEvent.setup()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { finish_reason: 'stop', message: { content: '经验卡片 [S1]' } },
        ],
      }),
    })
  )
  const post = vi
    .spyOn(api, 'post')
    .mockImplementation(async (_url, payload) => ({
      data: { success: true, data: { id: 8, ...(payload as object) } },
    }))
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await user.click(await screen.findByRole('button', { name: source.name }))
  await user.type(screen.getByLabelText('API token'), 'sk-temporary')
  await user.click(screen.getByRole('button', { name: 'Summarize all notes' }))
  const editor = await screen.findByLabelText('Edit research result')
  await user.clear(editor)
  await user.click(editor)
  await user.paste('人工修正的观点 [S1]')
  await user.clear(screen.getByLabelText('Result title'))
  await user.type(screen.getByLabelText('Result title'), '我的复盘')
  await user.click(screen.getByRole('button', { name: 'Save as new document' }))
  await screen.findByText('Research result saved')
  expect(post).toHaveBeenCalledWith(
    '/api/knowledge/documents',
    expect.objectContaining({ owner_id: 1, name: '我的复盘' })
  )
  const saved = {
    id: 8,
    ...(post.mock.calls[0][1] as { name: string; text: string }),
  }
  expect(saved.text).toContain('人工修正的观点')
  expect(saved.text).not.toContain('sk-temporary')
  view.unmount()
  vi.mocked(api.get).mockResolvedValue({
    data: { success: true, data: [source, saved] },
  })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await user.click(
    (await screen.findAllByRole('button', { name: '我的复盘' }))[1]
  )
  expect(await screen.findByLabelText('Edit research result')).toHaveValue(
    '人工修正的观点 [S1]'
  )
  expect(screen.getByLabelText('Result title')).toHaveValue('我的复盘')
  await user.click(screen.getByRole('button', { name: '[S1] 心得.txt' }))
  expect(
    within(screen.getByRole('dialog')).getByText(source.text)
  ).toBeVisible()
})

test('comparison requires two notes and an interrupted request never produces a saved result', async () => {
  const user = userEvent.setup()
  const fetchMock = vi.fn(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        )
      )
  )
  vi.stubGlobal('fetch', fetchMock)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await user.click(await screen.findByRole('button', { name: source.name }))
  await user.type(screen.getByLabelText('API token'), 'sk-temporary')
  expect(screen.getByRole('button', { name: 'Compare notes' })).toBeDisabled()
  await user.click(
    screen.getByRole('button', { name: 'Extract experience cards' })
  )
  expect(screen.getByRole('button', { name: source.name })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Stop analysis' }))
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Extract experience cards' })
    ).toBeEnabled()
  )
  expect(
    screen.queryByLabelText('Edit research result')
  ).not.toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert')).toHaveTextContent('Analysis stopped')
})

test('failed save retains the draft and reports failure without a success state', async () => {
  const report = {
    kind: 'rules' as const,
    body: '未保存修订',
    sources: [
      { id: 'S1', documentId: 7, name: source.name, start: 0, end: 10 },
    ],
  }
  vi.mocked(api.get).mockResolvedValue({
    data: {
      success: true,
      data: [
        source,
        { id: 8, name: '已存复盘', text: serializeReport(report) },
      ],
    },
  })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: false, message: 'save rejected' },
  })
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await user.click(
    (await screen.findAllByRole('button', { name: '已存复盘' }))[1]
  )
  await user.click(screen.getByRole('button', { name: 'Save as new document' }))
  await screen.findByText('Unable to save research result')
  expect(screen.getByLabelText('Edit research result')).toHaveValue(
    '未保存修订'
  )
  expect(screen.queryByText('Research result saved')).not.toBeInTheDocument()
})

test('changing accounts aborts analysis and removes the previous account result', async () => {
  const user = userEvent.setup()
  const fetchMock = vi.fn(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        )
      )
  )
  vi.stubGlobal('fetch', fetchMock)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await user.click(await screen.findByRole('button', { name: source.name }))
  await user.type(screen.getByLabelText('API token'), 'sk-temporary')
  await user.click(screen.getByRole('button', { name: 'Summarize all notes' }))
  useAuthStore.getState().auth.setUser({ id: 2, username: 'other', role: 1 })
  await waitFor(() =>
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  )
  expect(
    screen.queryByLabelText('Edit research result')
  ).not.toBeInTheDocument()
  expect(screen.getByLabelText('API token')).toHaveValue('')
})

test('a saved result can preview with the keyboard and marks a deleted source unavailable', async () => {
  const report = {
    kind: 'summary' as const,
    body: '**核心观点** [S1]',
    sources: [
      { id: 'S1', documentId: 99, name: '已删心得.txt', start: 0, end: 10 },
    ],
  }
  vi.mocked(api.get).mockResolvedValue({
    data: {
      success: true,
      data: [{ id: 8, name: '已存复盘', text: serializeReport(report) }],
    },
  })
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await user.click(
    (await screen.findAllByRole('button', { name: '已存复盘' }))[1]
  )
  const preview = screen.getByRole('button', { name: 'Preview' })
  preview.focus()
  await user.keyboard('[Enter]')
  expect(preview).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText('核心观点')).toBeVisible()
  expect(
    screen.getByRole('button', { name: /\[S1\] 已删心得.txt/ })
  ).toBeDisabled()
  await user.keyboard('[Enter]')
  expect(screen.getByLabelText('Edit research result')).toHaveValue(
    '**核心观点** [S1]'
  )
})
