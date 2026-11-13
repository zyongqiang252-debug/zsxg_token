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
import { afterEach, expect, test, vi } from 'vitest'

import {
  answerPassages,
  semanticChunks,
  semanticSearch,
} from '../semantic-search'

const docs = [
  { id: 1, name: 'notes.txt', text: '央行宽松压低融资成本。' },
  { id: 2, name: 'other.txt', text: '商品库存升高。' },
]
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('semantic retrieval finds a paraphrase without shared keywords and reuses the session index', async () => {
  const calls: { model: string; input: string[] }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body)
      calls.push(body)
      return {
        ok: true,
        json: async () => ({
          data: body.input
            .map((text: string, index: number) => ({
              index,
              embedding: text.includes('库存') ? [0, 1] : [1, 0],
            }))
            .reverse(),
        }),
      }
    })
  )
  const options = {
    documents: docs,
    query: '借钱变便宜的原因',
    model: 'embed-a',
    token: 'sk-transient',
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    index: null,
  }
  const first = await semanticSearch(options)
  expect(first.passages[0].documentId).toBe(1)
  expect(calls).toHaveLength(2)
  await semanticSearch({
    ...options,
    index: first.index,
    query: '资金价格为什么下降',
  })
  expect(calls).toHaveLength(3)
  await semanticSearch({ ...options, index: first.index, model: 'embed-b' })
  expect(calls).toHaveLength(5)
  expect(JSON.stringify(first.index)).not.toContain('sk-transient')
})

test('indexing covers the tail of long documents with original Unicode offsets', () => {
  const text = `${'中'.repeat(1200)}尾部😀`
  const chunks = semanticChunks([{ id: 7, name: 'long.txt', text }])
  expect(chunks.at(-1)?.end).toBe(1203)
  expect(chunks.at(-1)?.text.endsWith('尾部😀')).toBe(true)
  expect(chunks[1].start).toBeLessThan(chunks[0].end)
  expect(() =>
    semanticChunks([{ id: 1, name: 'large', text: 'x'.repeat(120001) }])
  ).toThrow()
})

test.each([
  {
    data: [
      { index: 0, embedding: [0, 0] },
      { index: 1, embedding: [1, 0] },
    ],
  },
  { data: [{ index: 0, embedding: [1, 0] }] },
  {
    data: [
      { index: 0, embedding: [1, 0] },
      { index: 0, embedding: [1, 0] },
    ],
  },
  {
    data: [
      { index: 0, embedding: [1, 0] },
      { index: 1, embedding: [1, 0, 0] },
    ],
  },
])('rejects invalid or incomplete embedding batches', async (json) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => json })
  )
  await expect(
    semanticSearch({
      documents: docs,
      query: 'query',
      model: 'embed',
      token: 't',
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      index: null,
    })
  ).rejects.toThrow()
})

test('aborting indexing prevents subsequent batches and query charges', async () => {
  const controller = new AbortController()
  const fetchMock = vi.fn(async (_url, options) => {
    const body = JSON.parse(options.body)
    controller.abort()
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
  await expect(
    semanticSearch({
      documents: [{ id: 1, name: 'large', text: 'x'.repeat(20000) }],
      query: 'q',
      model: 'embed',
      token: 't',
      signal: controller.signal,
      onProgress: vi.fn(),
      index: null,
    })
  ).rejects.toThrow()
  expect(fetchMock).toHaveBeenCalledOnce()
})

test('answering retrieved passages bypasses keyword filtering and preserves citation offsets', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [
        { finish_reason: 'stop', message: { content: '融资成本下降 [S1]' } },
      ],
    }),
  })
  vi.stubGlobal('fetch', fetchMock)
  const report = await answerPassages({
    question: '原因',
    passages: [
      {
        id: 'S1',
        documentId: 7,
        name: 'a.txt',
        text: '央行宽松',
        start: 520,
        end: 524,
        score: 0.9,
      },
    ],
    model: 'chat',
    token: 't',
    language: 'zh-CN',
    signal: new AbortController().signal,
  })
  const body = JSON.parse(fetchMock.mock.calls[0][1].body)
  expect(body.task).toBe('answer')
  expect(body.documents[0].text).toBe('央行宽松')
  expect(report.sources[0]).toMatchObject({
    documentId: 7,
    start: 520,
    end: 524,
  })
  expect(report.kind).toBe('answer')
})
