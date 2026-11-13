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
import { useMutation } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toIntlLocale } from '@/i18n/languages'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { ReportEditor } from './research-report-editor'
import type { ResearchReport, SavedDocument } from './research-workflow'
import {
  answerPassages,
  semanticChunks,
  semanticSearch,
  type SemanticIndex,
  type SemanticPassage,
} from './semantic-search'
import { SourceDialog } from './source-dialog'

export function KnowledgeSearch(props: {
  documents: SavedDocument[]
  allDocuments: SavedDocument[]
  model: string
  token: string
  disabled: boolean
  onBusyChange: (busy: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const ownerId = useAuthStore((state) => state.auth.user?.id)
  const [query, setQuery] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [result, setResult] = useState<SemanticPassage[] | null>(null)
  const [report, setReport] = useState<ResearchReport | null>(null)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [source, setSource] = useState<SemanticPassage | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const indexRef = useRef<SemanticIndex | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const corpusKey = useMemo(
    () => JSON.stringify(props.documents.map((doc) => [doc.id, doc.text])),
    [props.documents]
  )
  useEffect(() => {
    indexRef.current = null
    setResult(null)
    setReport(null)
    setSource(null)
    setError('')
    return () => {
      abortRef.current?.abort()
    }
  }, [corpusKey, embeddingModel, ownerId])
  useEffect(() => {
    indexRef.current = null
  }, [props.token])
  const chunkCount = useMemo(() => {
    try {
      return semanticChunks(props.documents).length
    } catch {
      return 0
    }
  }, [props.documents])
  const job = useMutation({
    retry: false,
    meta: { errorToast: false },
    mutationFn: async (mode: 'semantic' | 'keyword' | 'answer') => {
      const controller = new AbortController()
      abortRef.current = controller
      if (mode === 'answer') {
        return {
          mode,
          ownerId,
          report: await answerPassages({
            question: query,
            passages: result ?? [],
            model: props.model,
            token: props.token,
            language: locale ?? 'en',
            signal: controller.signal,
          }),
        }
      }
      if (mode === 'keyword') {
        const response = await api.post<{
          success: boolean
          data?: {
            document_id: string
            name: string
            text: string
            start_rune: number
            end_rune: number
            score: number
          }[]
        }>(
          '/api/knowledge/search',
          {
            query,
            documents: props.documents.map((doc) => ({
              id: String(doc.id),
              name: doc.name,
              text: doc.text,
            })),
            limit: 5,
          },
          { signal: controller.signal }
        )
        const matches = requireServerSuccess(response.data).data ?? []
        controller.signal.throwIfAborted()
        return {
          mode,
          ownerId,
          passages: matches.map((item, i) => ({
            id: `S${i + 1}`,
            documentId: Number(item.document_id),
            name: item.name,
            text: item.text,
            start: item.start_rune,
            end: item.end_rune,
            score: item.score,
          })),
        }
      }
      const data = await semanticSearch({
        documents: props.documents,
        query,
        model: embeddingModel,
        token: props.token,
        signal: controller.signal,
        index: indexRef.current,
        onProgress: (done, total) => {
          if (!controller.signal.aborted) setProgress({ done, total })
        },
      })
      controller.signal.throwIfAborted()
      indexRef.current = data.index
      return { mode, ownerId, passages: data.passages }
    },
    onSuccess: (data) => {
      if (useAuthStore.getState().auth.user?.id !== data.ownerId) return
      if (data.mode === 'answer' && data.report) {
        setReport(data.report)
        setRevision((value) => value + 1)
      } else {
        setResult(data.passages ?? [])
        setReport(null)
      }
    },
    onError: (failure) => {
      if (abortRef.current?.signal.aborted) return
      setError(
        t(
          'Unable to search or answer. Try keyword search or check the model configuration.'
        )
      )
      handleServerError(failure, t('Unable to complete the request'))
    },
    onSettled: () => props.onBusyChange(false),
  })
  function run(mode: 'semantic' | 'keyword' | 'answer'): void {
    setError('')
    setProgress({ done: 0, total: 1 })
    props.onBusyChange(true)
    job.mutate(mode)
  }
  const blocked =
    props.disabled ||
    job.isPending ||
    !ownerId ||
    !query.trim() ||
    [...query].length > 1000 ||
    !chunkCount
  const sourceDocument =
    props.allDocuments.find((doc) => doc.id === source?.documentId) ?? null
  const knowledgeBase = props.documents.every(
    (doc) =>
      (doc.knowledge_base ?? '') === (props.documents[0]?.knowledge_base ?? '')
  )
    ? (props.documents[0]?.knowledge_base ?? '')
    : ''
  return (
    <Card
      id='knowledge-search'
      className='scroll-mt-4 rounded-2xl border-0 shadow-sm'
    >
      <CardHeader>
        <CardTitle>{t('Search your knowledge base')}</CardTitle>
        <CardDescription>
          {t(
            'Search selected source documents, or all sources in the current knowledge base when none are selected.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        <Label htmlFor='knowledge-query'>{t('Knowledge query')}</Label>
        <Input
          id='knowledge-query'
          value={query}
          maxLength={1000}
          disabled={props.disabled || job.isPending}
          onChange={(event) => {
            setQuery(event.target.value)
            setResult(null)
            setReport(null)
          }}
        />
        <Label htmlFor='embedding-model'>{t('Embedding model')}</Label>
        <Input
          id='embedding-model'
          value={embeddingModel}
          disabled={props.disabled || job.isPending}
          onChange={(event) => setEmbeddingModel(event.target.value)}
          placeholder={t('Enter an embedding model enabled in your gateway')}
        />
        <p className='text-muted-foreground text-sm'>
          {t(
            'Semantic search sends document passages to the selected embedding provider and is billed by token usage. The index is reused only in this session.'
          )}
        </p>
        {!!chunkCount && (
          <p className='text-sm'>
            {t('Embedding requests for this search: {{count}}', {
              count: formatNumber(
                indexRef.current ? 1 : Math.ceil(chunkCount / 16) + 1,
                locale
              ),
            })}
          </p>
        )}
        {props.documents.length > 0 && !chunkCount && (
          <p role='alert'>
            {t(
              'Select nonempty documents totaling at most 120,000 characters.'
            )}
          </p>
        )}
        <div className='flex flex-wrap gap-2'>
          <Button
            type='button'
            disabled={blocked || !embeddingModel.trim() || !props.token.trim()}
            onClick={() => run('semantic')}
          >
            {t('Semantic search')}
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={blocked}
            onClick={() => run('keyword')}
          >
            {t('Keyword search')}
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={props.disabled || job.isPending || !indexRef.current}
            onClick={() => {
              indexRef.current = null
              setResult(null)
              setReport(null)
            }}
          >
            {t('Clear session index')}
          </Button>
          {job.isPending && (
            <Button
              type='button'
              variant='outline'
              onClick={() => {
                abortRef.current?.abort()
                setError(
                  t(
                    'Analysis stopped. Completed requests may have been billed.'
                  )
                )
              }}
            >
              {t('Stop analysis')}
            </Button>
          )}
        </div>
        {job.isPending && (
          <p role='status'>
            {t('Analysis progress: {{done}} / {{total}} requests', {
              done: formatNumber(progress.done, locale),
              total: formatNumber(progress.total, locale),
            })}
          </p>
        )}
        {error && <p role='alert'>{error}</p>}
        {result?.length === 0 && (
          <p role='status'>{t('No matching passages')}</p>
        )}
        {result?.map((item) => (
          <div key={item.id} className='space-y-2 rounded-xl border p-3'>
            <Button
              type='button'
              variant='outline'
              className='max-w-full'
              onClick={() => setSource(item)}
            >
              <span className='truncate'>
                [{item.id}] {item.name}
              </span>
            </Button>
            <p className='text-sm break-words whitespace-pre-wrap'>
              {item.text}
            </p>
          </div>
        ))}
        {!!result?.length && (
          <Button
            type='button'
            disabled={
              props.disabled ||
              job.isPending ||
              !props.token.trim() ||
              !props.model.trim()
            }
            onClick={() => run('answer')}
          >
            {t('Ask agent using these passages')}
          </Button>
        )}
        {report && ownerId && (
          <ReportEditor
            key={revision}
            report={report}
            title={query}
            documents={props.allDocuments}
            ownerId={ownerId}
            knowledgeBase={knowledgeBase}
            disabled={props.disabled || job.isPending}
          />
        )}
        <SourceDialog
          document={sourceDocument}
          source={source ?? undefined}
          onClose={() => setSource(null)}
        />
      </CardContent>
    </Card>
  )
}
