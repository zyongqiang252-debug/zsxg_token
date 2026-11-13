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
import { z } from 'zod'

import type { KnowledgeMetadata } from './knowledge-metadata'

export type SavedDocument = {
  id: number
  name: string
  text: string
  document_type?: string
  created_at?: number
} & Partial<KnowledgeMetadata>
export type ResearchTask =
  | 'summary'
  | 'rules'
  | 'compare'
  | 'organize'
  | 'timeline'
  | 'conflicts'
const sourceSchema = z
  .object({
    id: z.string().regex(/^S\d+$/),
    documentId: z.number().int().positive(),
    name: z.string().max(255),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive().max(100000),
  })
  .refine((source) => source.end > source.start)
export type ResearchSource = z.infer<typeof sourceSchema>
const reportSchema = z.object({
  kind: z.enum([
    'summary',
    'rules',
    'compare',
    'organize',
    'timeline',
    'conflicts',
    'answer',
  ]),
  body: z.string().min(1).max(90000),
  sources: z.array(sourceSchema).min(1).max(40),
})
export type ResearchReport = z.infer<typeof reportSchema>
const reportPrefix = '<!-- research-report:v1 -->\n'
export const maxResearchCharacters = 120000

export function readReport(text: string): ResearchReport | null {
  if (!text.startsWith(reportPrefix)) return null
  try {
    return reportSchema.parse(JSON.parse(text.slice(reportPrefix.length)))
  } catch {
    return null
  }
}

export function serializeReport(report: ResearchReport): string {
  const text = reportPrefix + JSON.stringify(reportSchema.parse(report))
  if ([...text].length > 100000) throw new Error('Report too large')
  return text
}

export function researchSources(documents: SavedDocument[]): ResearchSource[] {
  const sources: ResearchSource[] = []
  const total = documents.reduce((sum, item) => sum + [...item.text].length, 0)
  if (
    !documents.length ||
    documents.length > 20 ||
    total > maxResearchCharacters
  ) {
    throw new Error('Invalid research documents')
  }
  for (const document of documents) {
    const size = [...document.text].length
    if (!document.text.trim()) throw new Error('Empty research document')
    for (let start = 0; start < size; start += 6000) {
      sources.push({
        id: `S${sources.length + 1}`,
        documentId: document.id,
        name: document.name,
        start,
        end: Math.min(start + 6000, size),
      })
    }
  }
  return sources
}

type Material = { id: string; name: string; text: string }
export async function runResearch(options: {
  task: ResearchTask
  documents: SavedDocument[]
  model: string
  token: string
  language: string
  signal: AbortSignal
  onProgress: (done: number, total: number) => void
}): Promise<ResearchReport> {
  const sources = researchSources(options.documents)
  if (
    ['compare', 'timeline', 'conflicts'].includes(options.task) &&
    options.documents.length < 2
  ) {
    throw new Error('Comparison requires multiple documents')
  }
  let done = 0
  let total = sources.length + 1
  const request = async (
    task: ResearchTask | 'notes',
    documents: Material[],
    context = ''
  ): Promise<string> => {
    options.signal.throwIfAborted()
    options.onProgress(done, total)
    const response = await fetch('/v1/agent/chat/completions', {
      method: 'POST',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.token.trim()}`,
      },
      body: JSON.stringify({
        model: options.model.trim(),
        task,
        context,
        question: `Process all provided material. Output language: ${options.language}.`,
        max_tokens: task === 'notes' ? 2048 : 4096,
        documents,
        reasoning_effort: options.model
          .trim()
          .toLowerCase()
          .startsWith('deepseek-')
          ? 'none'
          : undefined,
      }),
    })
    if (!response.ok) {
      throw new Error(`Research request failed (${response.status})`)
    }
    const result: {
      choices?: { finish_reason?: string; message?: { content?: string } }[]
    } = await response.json()
    const choice = result.choices?.[0]
    if (
      !choice?.message?.content?.trim() ||
      (choice.finish_reason && choice.finish_reason !== 'stop')
    ) {
      throw new Error('Research response incomplete')
    }
    options.signal.throwIfAborted()
    done += 1
    options.onProgress(done, total)
    return choice.message.content
  }
  const notes: string[] = []
  for (const source of sources) {
    const document = options.documents.find(
      (item) => item.id === source.documentId
    )
    if (!document) throw new Error('Source document missing')
    notes.push(
      await request(
        'notes',
        [
          {
            id: source.id,
            name: document.name,
            text: [...document.text].slice(source.start, source.end).join(''),
          },
        ],
        JSON.stringify({
          document_id: source.id,
          declared_metadata: {
            knowledge_base: document.knowledge_base,
            author: document.author,
            document_date: document.document_date,
            topic: document.topic,
            instrument: document.instrument,
            conditions: document.conditions,
          },
        })
      )
    )
  }
  let combined = notes
    .map(
      (note, index) => `[${sources[index].id}] ${sources[index].name}\n${note}`
    )
    .join('\n\n')
  // Reduce every character of intermediate notes, with bounded fan-in and no silent truncation.
  for (let level = 0; [...combined].length > 16000; level += 1) {
    if (level >= 5) throw new Error('Research notes did not converge')
    const chars = [...combined]
    const reduced: string[] = []
    total += Math.ceil(chars.length / 12000)
    for (let start = 0; start < chars.length; start += 12000) {
      reduced.push(
        await request('notes', [
          {
            id: 'intermediate',
            name: 'Intermediate notes',
            text: chars.slice(start, start + 12000).join(''),
          },
        ])
      )
    }
    const next = reduced.join('\n\n')
    if ([...next].length >= chars.length) {
      throw new Error('Research notes did not converge')
    }
    combined = next
  }
  const body = await request(options.task, [
    { id: 'notes', name: 'All source notes', text: combined },
  ])
  const sourceIds = new Set(sources.map((source) => source.id))
  for (const marker of body.matchAll(/\[(S\d+)\]/g)) {
    if (!sourceIds.has(marker[1])) throw new Error('Unknown source marker')
  }
  return { kind: options.task, body, sources }
}
