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
import type {
  ResearchReport,
  ResearchSource,
  SavedDocument,
} from './research-workflow'

export type SemanticPassage = ResearchSource & { text: string; score: number }
type Chunk = ResearchSource & { text: string }
export type SemanticIndex = {
  key: string
  model: string
  chunks: Chunk[]
  vectors: number[][]
}

export function semanticChunks(documents: SavedDocument[]): Chunk[] {
  if (
    !documents.length ||
    documents.length > 20 ||
    documents.reduce((sum, doc) => sum + [...doc.text].length, 0) > 120000
  ) {
    throw new Error('Invalid search corpus')
  }
  const chunks: Chunk[] = []
  for (const doc of documents) {
    const text = [...doc.text]
    for (let start = 0; start < text.length; start += 520) {
      const end = Math.min(start + 600, text.length)
      chunks.push({
        id: `S${chunks.length + 1}`,
        documentId: doc.id,
        name: doc.name,
        start,
        end,
        text: text.slice(start, end).join(''),
      })
      if (end === text.length) break
    }
  }
  if (!chunks.length) throw new Error('Empty search corpus')
  return chunks
}

function unitVector(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8192 ||
    !value.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new Error('Invalid embedding vector')
  }
  const norm = Math.sqrt(
    value.reduce((sum: number, n: number) => sum + n * n, 0)
  )
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error('Invalid embedding norm')
  }
  return value.map((n: number) => n / norm)
}

export async function semanticSearch(options: {
  documents: SavedDocument[]
  query: string
  model: string
  token: string
  signal: AbortSignal
  index: SemanticIndex | null
  onProgress: (done: number, total: number) => void
}): Promise<{ index: SemanticIndex; passages: SemanticPassage[] }> {
  const chunks = semanticChunks(options.documents)
  if (
    !options.query.trim() ||
    [...options.query].length > 1000 ||
    !options.model.trim() ||
    !options.token.trim()
  ) {
    throw new Error('Invalid semantic search input')
  }
  const key = JSON.stringify(options.documents.map((doc) => [doc.id, doc.text]))
  const reusable =
    options.index?.key === key && options.index.model === options.model.trim()
  let done = 0
  const total = (reusable ? 0 : Math.ceil(chunks.length / 16)) + 1
  const embed = async (input: string[]): Promise<number[][]> => {
    options.signal.throwIfAborted()
    options.onProgress(done, total)
    const response = await fetch('/v1/embeddings', {
      method: 'POST',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.token.trim()}`,
      },
      body: JSON.stringify({ model: options.model.trim(), input }),
    })
    if (!response.ok) {
      throw new Error(`Embedding request failed (${response.status})`)
    }
    const json: { data?: { index: number; embedding: unknown }[] } =
      await response.json()
    if (!json.data || json.data.length !== input.length) {
      throw new Error('Incomplete embedding batch')
    }
    const ordered = [...json.data].sort((a, b) => a.index - b.index)
    const vectors = ordered.map((item, index) => {
      if (item.index !== index) throw new Error('Invalid embedding index')
      return unitVector(item.embedding)
    })
    options.signal.throwIfAborted()
    done++
    options.onProgress(done, total)
    return vectors
  }
  let index = options.index
  if (!reusable || !index) {
    const vectors: number[][] = []
    for (let start = 0; start < chunks.length; start += 16) {
      vectors.push(
        ...(await embed(
          chunks.slice(start, start + 16).map((chunk) => chunk.text)
        ))
      )
    }
    if (vectors.some((vector) => vector.length !== vectors[0].length)) {
      throw new Error('Inconsistent embedding dimensions')
    }
    index = { key, model: options.model.trim(), chunks, vectors }
  }
  const [query] = await embed([options.query.trim()])
  if (query.length !== index.vectors[0].length) {
    throw new Error('Embedding model dimensions changed')
  }
  const passages = index.chunks
    .map((chunk, i) => ({
      ...chunk,
      score: index.vectors[i].reduce((sum, n, j) => sum + n * query[j], 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
  return {
    index,
    passages: passages.map((passage, i) => ({ ...passage, id: `S${i + 1}` })),
  }
}

export async function answerPassages(options: {
  question: string
  passages: SemanticPassage[]
  model: string
  token: string
  language: string
  signal: AbortSignal
}): Promise<ResearchReport> {
  options.signal.throwIfAborted()
  if (!options.question.trim() || options.passages.length < 1) {
    throw new Error('Missing search evidence')
  }
  const response = await fetch('/v1/agent/chat/completions', {
    method: 'POST',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.token.trim()}`,
    },
    body: JSON.stringify({
      model: options.model.trim(),
      task: 'answer',
      question: options.question,
      context: JSON.stringify({ response_language: options.language }),
      max_tokens: 4096,
      documents: options.passages.map((item) => ({
        id: item.id,
        name: item.name,
        text: item.text,
      })),
      reasoning_effort: options.model
        .trim()
        .toLowerCase()
        .startsWith('deepseek-')
        ? 'none'
        : undefined,
    }),
  })
  if (!response.ok) {
    throw new Error(`Answer request failed (${response.status})`)
  }
  const data: {
    choices?: { finish_reason?: string; message?: { content?: string } }[]
  } = await response.json()
  const choice = data.choices?.[0]
  if (
    !choice?.message?.content?.trim() ||
    (choice.finish_reason && choice.finish_reason !== 'stop')
  ) {
    throw new Error('Incomplete answer')
  }
  options.signal.throwIfAborted()
  const ids = new Set(options.passages.map((item) => item.id))
  for (const marker of choice.message.content.matchAll(/\[(S\d+)\]/g)) {
    if (!ids.has(marker[1])) throw new Error('Unknown citation')
  }
  return {
    kind: 'answer',
    body: choice.message.content,
    sources: options.passages.map(({ id, documentId, name, start, end }) => ({
      id,
      documentId,
      name,
      start,
      end,
    })),
  }
}
