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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { ResearchAssistant } from '../index'

beforeEach(() => {
  useAuthStore.getState().auth.setUser({ id: 1, username: 'test', role: 1 })
})
afterEach(() => {
  useAuthStore.getState().auth.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('uploading multiple user files attaches metadata and keeps successful files when a later file fails', async () => {
  vi.spyOn(api, 'get')
    .mockResolvedValueOnce({ data: { success: true, data: [] } })
    .mockResolvedValue({
      data: {
        success: true,
        data: [
          {
            id: 7,
            name: 'one.txt',
            text: 'first source',
            knowledge_base: '我的资料',
          },
        ],
      },
    })
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValueOnce({
      data: { success: true, data: { name: 'one.txt', text: 'first source' } },
    })
    .mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          id: 7,
          name: 'one.txt',
          text: 'first source',
          knowledge_base: '我的资料',
        },
      },
    })
    .mockRejectedValueOnce(new Error('Unreadable second file'))
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await user.click(screen.getByText('Metadata for uploaded documents'))
  await user.type(screen.getByLabelText('Knowledge base'), ' 我的资料 ')
  await user.type(screen.getByLabelText('Document author'), '作者甲')
  await waitFor(() => expect(screen.getByLabelText('Document')).toBeEnabled())
  await user.upload(screen.getByLabelText('Document'), [
    new File(['first source'], 'one.txt', { type: 'text/plain' }),
    new File(['bad'], 'two.txt', { type: 'text/plain' }),
  ])
  await screen.findByText('Unable to read or save the document')
  expect(await screen.findByRole('button', { name: 'one.txt' })).toBeVisible()
  expect(post.mock.calls[1][1]).toMatchObject({
    owner_id: 1,
    knowledge_base: '我的资料',
    author: '作者甲',
  })
})

test('editing metadata persists it and filtering a knowledge base limits agent organization to its source documents', async () => {
  const docs = [
    {
      id: 1,
      name: 'a.txt',
      text: 'a source',
      knowledge_base: 'A',
      author: '甲',
    },
    { id: 2, name: 'b.txt', text: 'b source', knowledge_base: 'B' },
  ]
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: docs },
  })
  const patch = vi.spyOn(api, 'put').mockResolvedValue({
    data: { success: true, data: { ...docs[0], topic: '利率' } },
  })
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [
        { finish_reason: 'stop', message: { content: '主题目录 [S1]' } },
      ],
    }),
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await user.click(
    await screen.findByRole('button', { name: 'Edit document metadata: a.txt' })
  )
  await user.type(screen.getAllByLabelText('Document topic')[1], '利率')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith(
      '/api/knowledge/documents/1/metadata',
      expect.objectContaining({ owner_id: 1, topic: '利率' })
    )
  )
  await user.selectOptions(screen.getByLabelText('Current knowledge base'), 'A')
  expect(
    screen.queryByRole('button', { name: 'b.txt' })
  ).not.toBeInTheDocument()
  await user.type(screen.getByLabelText('API token'), 'sk-temporary')
  await user.click(
    screen.getByRole('button', { name: 'Organize knowledge base' })
  )
  await screen.findByLabelText('Edit research result')
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).documents[0].text).toBe(
    'a source'
  )
  expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body).task).toBe(
    'organize'
  )
})

test('keyword search remains usable without an embedding model and can hand evidence to the agent', async () => {
  const doc = { id: 7, name: 'user.txt', text: '宽松政策降低融资成本' }
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: [doc] },
  })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: [
        {
          document_id: '7',
          name: doc.name,
          text: doc.text,
          start_rune: 0,
          end_rune: doc.text.length,
          score: 2,
        },
      ],
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { finish_reason: 'stop', message: { content: '原文分析 [S1]' } },
        ],
      }),
    })
  )
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await screen.findByRole('button', { name: 'user.txt' })
  await user.type(screen.getByLabelText('Knowledge query'), '融资成本')
  expect(screen.getByRole('button', { name: 'Semantic search' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Keyword search' }))
  await screen.findByText(doc.text)
  await user.type(screen.getByLabelText('API token'), 'sk-temporary')
  await user.click(
    screen.getByRole('button', { name: 'Ask agent using these passages' })
  )
  expect(await screen.findByLabelText('Edit research result')).toHaveValue(
    '原文分析 [S1]'
  )
})

test('semantic search reuses vectors for a new query and clears retrieved evidence on account switch', async () => {
  const doc = { id: 7, name: 'private.txt', text: '货币宽松降低融资成本' }
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: [doc] },
  })
  const fetchMock = vi.fn(async (_url, options) => {
    const body = JSON.parse(options.body)
    return {
      ok: true,
      json: async () => ({
        data: body.input.map((_text: string, index: number) => ({
          index,
          embedding: [1, 0],
        })),
      }),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await screen.findByRole('button', { name: 'private.txt' })
  await user.type(screen.getByLabelText('API token'), 'sk-local')
  await user.type(screen.getByLabelText('Embedding model'), 'vector-a')
  await user.type(screen.getByLabelText('Knowledge query'), '借钱为什么变便宜')
  await user.click(screen.getByRole('button', { name: 'Semantic search' }))
  await screen.findByText(doc.text)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await user.clear(screen.getByLabelText('Knowledge query'))
  await user.type(screen.getByLabelText('Knowledge query'), '资金价格下降')
  await user.click(screen.getByRole('button', { name: 'Semantic search' }))
  await screen.findByText(doc.text)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  useAuthStore.getState().auth.setUser({ id: 2, username: 'other', role: 1 })
  await waitFor(() =>
    expect(screen.queryByText(doc.text)).not.toBeInTheDocument()
  )
  expect(screen.getByLabelText('API token')).toHaveValue('')
  expect(screen.getByLabelText('Embedding model')).toHaveValue('')
})

test('an empty current knowledge base stays selected after its last document moves to another base', async () => {
  const doc = { id: 1, name: 'a.txt', text: 'source', knowledge_base: 'A' }
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: [doc] },
  })
  vi.spyOn(api, 'put').mockResolvedValue({
    data: { success: true, data: { ...doc, knowledge_base: 'B' } },
  })
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await screen.findByRole('button', { name: 'a.txt' })
  await user.selectOptions(screen.getByLabelText('Current knowledge base'), 'A')
  await user.click(
    screen.getByRole('button', { name: 'Edit document metadata: a.txt' })
  )
  const name = screen.getAllByLabelText('Knowledge base')[1]
  await user.clear(name)
  await user.type(name, 'B')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(screen.getByLabelText('Current knowledge base')).toHaveValue('A')
  expect(screen.getByText('No matching documents')).toBeVisible()
  await user.selectOptions(screen.getByLabelText('Current knowledge base'), 'B')
  expect(screen.getByRole('button', { name: 'a.txt' })).toBeVisible()
})
