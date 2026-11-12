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
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { ResearchAssistant } from '../index'

beforeEach(() => {
  useAuthStore.getState().auth.setUser({ id: 1, username: 'test', role: 1 })
  vi.spyOn(api, 'get').mockResolvedValue({ data: { success: true, data: [] } })
})

afterEach(() => {
  useAuthStore.getState().auth.reset()
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('requires the inputs before sending a billed request', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await userEvent.click(screen.getByRole('button', { name: 'Ask assistant' }))
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Enter a model, API token, question and at least one source'
  )
})

test('imports a document and sends it with an ephemeral token', async () => {
  vi.mocked(api.get)
    .mockResolvedValueOnce({ data: { success: true, data: [] } })
    .mockResolvedValue({
      data: {
        success: true,
        data: [{ id: 7, name: 'report.txt', text: '营业收入增长' }],
      },
    })
  vi.spyOn(api, 'post')
    .mockResolvedValueOnce({
      data: {
        success: true,
        data: { name: 'report.txt', text: '营业收入增长' },
      },
    })
    .mockResolvedValueOnce({
      data: {
        success: true,
        data: { id: 7, name: 'report.txt', text: '营业收入增长' },
      },
    })
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '收入增长' } }] }),
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await waitFor(() => expect(screen.getByLabelText('Document')).toBeEnabled())
  await user.upload(
    screen.getByLabelText('Document'),
    new File(['营业收入增长'], 'report.txt', { type: 'text/plain' })
  )
  await screen.findByText(/report.txt/)
  await user.type(screen.getByLabelText('API token'), 'sk-example')
  await user.type(screen.getByLabelText('Question'), '营业收入如何')
  await user.click(screen.getByRole('button', { name: 'Ask assistant' }))
  await screen.findByText('收入增长')
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  const [path, options] = fetchMock.mock.calls[0]
  expect(path).toBe('/v1/agent/chat/completions')
  expect(options.headers.Authorization).toBe('Bearer sk-example')
  expect(JSON.parse(options.body).documents[0].text).toBe('营业收入增长')
})

test('selects multiple saved documents and confirms deletion', async () => {
  vi.mocked(api.get).mockResolvedValueOnce({
    data: {
      success: true,
      data: [
        { id: 1, name: 'one.txt', text: 'one text' },
        { id: 2, name: 'two.txt', text: 'two text' },
      ],
    },
  })
  const remove = vi
    .spyOn(api, 'delete')
    .mockResolvedValue({ data: { success: true } })
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'answer' } }] }),
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await user.click(await screen.findByRole('button', { name: 'one.txt' }))
  await user.click(screen.getByRole('button', { name: 'two.txt' }))
  await user.type(screen.getByLabelText('API token'), 'sk-example')
  await user.type(screen.getByLabelText('Question'), 'question')
  await user.click(screen.getByRole('button', { name: 'Ask assistant' }))
  await screen.findByText('answer')
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).documents).toHaveLength(2)
  await user.click(
    screen.getByRole('button', { name: 'Delete document: one.txt' })
  )
  expect(remove).not.toHaveBeenCalled()
  const dialog = screen.getByRole('alertdialog')
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith('/api/knowledge/documents/1')
  )
})

test('attaches a backtest result and asks without a document', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        trades: [],
        equity: [{ date: '2026-01-05', equity_fen: 10000000 }],
      },
    },
  })
  const fetchMock = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Analysis' } }] }),
    })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await user.type(
    screen.getByLabelText('Daily price data'),
    '2026-01-05,1000,1010'
  )
  await user.click(screen.getByRole('button', { name: 'Run backtest' }))
  await user.click(
    await screen.findByRole('button', { name: 'Attach result to assistant' })
  )
  await user.type(screen.getByLabelText('API token'), 'sk-example')
  await user.click(screen.getByRole('button', { name: 'Ask assistant' }))
  await screen.findByText('Analysis')
  const body = JSON.parse(fetchMock.mock.calls[0][1].body)
  expect(body.documents).toEqual([])
  expect(JSON.parse(body.context)).toMatchObject({
    kind: 'backtest',
    final_equity_fen: 10000000,
  })
})
