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

const field = (limit: number) =>
  z
    .string()
    .trim()
    .max(limit)
    .refine((value) => !value.includes('\0'))
export const metadataSchema = z.object({
  knowledge_base: field(100).refine((value) => value !== '*'),
  author: field(100),
  topic: field(200),
  instrument: field(100),
  conditions: field(2000),
  document_date: z
    .string()
    .refine(
      (value) =>
        value === '' ||
        (/^\d{4}-\d{2}-\d{2}$/.test(value) &&
          Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
          new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value)
    ),
})
export type KnowledgeMetadata = z.infer<typeof metadataSchema>
export const emptyMetadata: KnowledgeMetadata = {
  knowledge_base: '',
  author: '',
  topic: '',
  instrument: '',
  conditions: '',
  document_date: '',
}
export const metadataFields = [
  { key: 'knowledge_base', label: 'Knowledge base', limit: 100 },
  { key: 'author', label: 'Document author', limit: 100 },
  { key: 'document_date', label: 'Document date', limit: 10 },
  { key: 'topic', label: 'Document topic', limit: 200 },
  { key: 'instrument', label: 'Instrument or subject', limit: 100 },
  { key: 'conditions', label: 'Applicable conditions', limit: 2000 },
] as const
