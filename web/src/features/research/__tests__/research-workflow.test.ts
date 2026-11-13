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
  readReport,
  researchSources,
  runResearch,
  serializeReport,
} from '../research-workflow'

const docs = [
  { id: 7, name: 'notes.txt', text: `开头${'中'.repeat(5998)}尾部证据😀` },
]
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('processes every character including the unmatched tail before synthesizing', async () => {
  const requests: {
    task: string
    documents: { id: string; text: string }[]
  }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body)
      requests.push(body)
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: `evidence [${body.documents[0].id}]` },
            },
          ],
        }),
      }
    })
  )
  const progress = vi.fn()
  const report = await runResearch({
    task: 'summary',
    documents: docs,
    model: 'm',
    token: 'secret',
    language: 'zh',
    signal: new AbortController().signal,
    onProgress: progress,
  })
  expect(requests.map((item) => item.task)).toEqual([
    'notes',
    'notes',
    'summary',
  ])
  expect(
    requests
      .slice(0, 2)
      .map((item) => item.documents[0].text)
      .join('')
  ).toBe(docs[0].text)
  expect(requests[2].documents[0].text).toContain('[S2]')
  expect(report.sources[1]).toMatchObject({
    documentId: 7,
    start: 6000,
    end: 6005,
  })
  expect(progress).toHaveBeenLastCalledWith(3, 3)
  expect(serializeReport(report)).not.toContain('secret')
  expect(readReport(serializeReport(report))).toEqual(report)
})

test('rejects an over-limit selection and single-document comparison before calling a model', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  expect(() =>
    researchSources([{ ...docs[0], text: 'x'.repeat(120001) }])
  ).toThrow()
  await expect(
    runResearch({
      task: 'compare',
      documents: docs,
      model: 'm',
      token: 't',
      language: 'en',
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })
  ).rejects.toThrow('Comparison')
  expect(fetchMock).not.toHaveBeenCalled()
})

test('stops after a failed or truncated chunk instead of returning a complete report', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
    }),
  })
  vi.stubGlobal('fetch', fetchMock)
  await expect(
    runResearch({
      task: 'rules',
      documents: docs,
      model: 'm',
      token: 't',
      language: 'en',
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })
  ).rejects.toThrow('incomplete')
  expect(fetchMock).toHaveBeenCalledOnce()
})

test('aborting a job prevents any subsequent billed requests', async () => {
  const controller = new AbortController()
  const fetchMock = vi.fn(async () => {
    controller.abort()
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'notes' } }] }),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  await expect(
    runResearch({
      task: 'summary',
      documents: docs,
      model: 'm',
      token: 't',
      language: 'en',
      signal: controller.signal,
      onProgress: vi.fn(),
    })
  ).rejects.toThrow()
  expect(fetchMock).toHaveBeenCalledOnce()
})

test('recursively reduces long notes without dropping any intermediate material', async () => {
  const requests: { task: string; documents: { text: string }[] }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body))
      const content =
        requests.length <= 3 ? '保留[S1]'.repeat(1300) : '压缩后的证据[S1]'
      return {
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: 'stop', message: { content } }],
        }),
      }
    })
  )
  await runResearch({
    task: 'summary',
    documents: [{ ...docs[0], text: '中'.repeat(18000) }],
    model: 'm',
    token: 't',
    language: 'zh',
    signal: new AbortController().signal,
    onProgress: vi.fn(),
  })
  const reductions = requests.slice(3, -1)
  expect(reductions.length).toBeGreaterThan(1)
  expect(reductions.map((item) => item.documents[0].text).join('')).toContain(
    'S3'
  )
  expect(
    requests.every((item) => [...item.documents[0].text].length <= 24000)
  ).toBe(true)
})

test('ordinary documents and malformed saved reports are not parsed as reports', () => {
  expect(readReport('normal notes')).toBeNull()
  expect(readReport('<!-- research-report:v1 -->\n{}')).toBeNull()
})

test('compares both selected documents and preserves references to each source', async () => {
  const requests: {
    task: string
    documents: { id: string; text: string }[]
  }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body)
      requests.push(body)
      const content =
        body.task === 'compare'
          ? '观点分歧 [S1] [S2]'
          : `原文依据 [${body.documents[0].id}]`
      return {
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: 'stop', message: { content } }],
        }),
      }
    })
  )
  const result = await runResearch({
    task: 'compare',
    documents: [docs[0], { id: 8, name: 'other.txt', text: '相反观点' }],
    model: 'm',
    token: 't',
    language: 'zh',
    signal: new AbortController().signal,
    onProgress: vi.fn(),
  })
  expect(requests.at(-1)?.task).toBe('compare')
  expect(
    requests
      .slice(0, -1)
      .map((item) => item.documents[0].text)
      .join('')
  ).toBe(`${docs[0].text}相反观点`)
  expect(result.sources.map((item) => item.documentId)).toEqual([7, 7, 8])
})

test('rejects invented source markers rather than displaying a false citation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          { finish_reason: 'stop', message: { content: '虚构引用 [S999]' } },
        ],
      }),
    })
  )
  await expect(
    runResearch({
      task: 'summary',
      documents: docs,
      model: 'm',
      token: 't',
      language: 'zh',
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })
  ).rejects.toThrow('Unknown source marker')
})
