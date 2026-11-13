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
import { Label } from '@/components/ui/label'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { useAuthStore } from '@/stores/auth-store'

import { ReportEditor } from './research-report-editor'
import {
  readReport,
  researchSources,
  runResearch,
  type ResearchReport,
  type ResearchTask,
  type SavedDocument,
} from './research-workflow'

export function ResearchActions(props: {
  documents: SavedDocument[]
  selected: SavedDocument[]
  corpus: SavedDocument[]
  scope: string
  model: string
  token: string
  disabled: boolean
  onBusyChange: (busy: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const ownerId = useAuthStore((state) => state.auth.user?.id)
  const abortRef = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState('')
  const [report, setReport] = useState<ResearchReport | null>(null)
  const [title, setTitle] = useState('')
  const [knowledgeBase, setKnowledgeBase] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [ownerId]
  )
  useEffect(() => {
    setReport(null)
    setError('')
  }, [ownerId])
  const job = useMutation({
    retry: false,
    meta: { errorToast: false },
    mutationFn: async ({
      task,
      documents,
    }: {
      task: ResearchTask
      documents: SavedDocument[]
    }) => {
      const controller = new AbortController()
      abortRef.current = controller
      const result = await runResearch({
        task,
        documents,
        token: props.token,
        model: props.model,
        language: locale ?? 'en',
        signal: controller.signal,
        onProgress: (done, total) => {
          if (!controller.signal.aborted) setProgress({ done, total })
        },
      })
      return {
        result,
        ownerId,
        knowledgeBase: documents.every(
          (doc) => doc.knowledge_base === documents[0]?.knowledge_base
        )
          ? (documents[0]?.knowledge_base ?? '')
          : '',
      }
    },
    onSuccess: (data) => {
      if (useAuthStore.getState().auth.user?.id !== data.ownerId) return
      setKnowledgeBase(data.knowledgeBase)
      setReport(data.result)
      setTitle(t('Research result'))
      setRevision((value) => value + 1)
    },
    onError: (failure) => {
      if (abortRef.current?.signal.aborted) return
      setError(
        t(
          'Research failed. No complete result was produced; completed requests may have been billed.'
        )
      )
      handleServerError(failure, t('Unable to complete the request'))
    },
    onSettled: () => props.onBusyChange(false),
  })
  const sourceCount = useMemo(() => {
    try {
      return researchSources(props.selected).length
    } catch {
      return 0
    }
  }, [props.selected])
  const valid = sourceCount > 0
  const blocked =
    props.disabled ||
    job.isPending ||
    !ownerId ||
    !props.token.trim() ||
    !props.model.trim() ||
    !valid
  const corpusCount = useMemo(() => {
    try {
      return researchSources(props.corpus).length
    } catch {
      return 0
    }
  }, [props.corpus])
  const corpusBlocked =
    props.disabled ||
    job.isPending ||
    !ownerId ||
    !props.token.trim() ||
    !props.model.trim() ||
    !corpusCount
  function start(task: ResearchTask, documents = props.selected): void {
    setError('')
    setProgress({ done: 0, total: researchSources(documents).length + 1 })
    props.onBusyChange(true)
    job.mutate({ task, documents })
  }
  const savedReports = useMemo(
    () =>
      props.documents.filter(
        (document) =>
          readReport(document.text) &&
          (props.scope === '*' ||
            (document.knowledge_base ?? '') === props.scope)
      ),
    [props.documents, props.scope]
  )
  return (
    <Card
      id='knowledge-organization'
      className='scroll-mt-4 rounded-2xl border-0 shadow-sm'
    >
      <CardHeader>
        <CardTitle>{t('Knowledge organization agent')}</CardTitle>
        <CardDescription>
          {t(
            'Read every selected document, organize experience, and keep an editable result with source links.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        <p className='text-sm'>
          {t(
            'Organize all source documents in the current knowledge base. Generated reports are excluded.'
          )}
        </p>
        {!!corpusCount && (
          <p className='text-muted-foreground text-sm'>
            {t(
              'At least {{count}} model requests; each is billed by token usage.',
              { count: formatNumber(corpusCount + 1, locale) }
            )}
          </p>
        )}
        <div className='flex flex-wrap gap-2'>
          <Button
            type='button'
            disabled={corpusBlocked}
            onClick={() => start('organize', props.corpus)}
          >
            {t('Organize knowledge base')}
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={corpusBlocked || props.corpus.length < 2}
            onClick={() => start('timeline', props.corpus)}
          >
            {t('Trace viewpoint changes')}
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={corpusBlocked || props.corpus.length < 2}
            onClick={() => start('conflicts', props.corpus)}
          >
            {t('Find conflicting views')}
          </Button>
        </div>
        {props.corpus.length > 0 && !corpusCount && (
          <p role='alert'>
            {t(
              'Select nonempty documents totaling at most 120,000 characters.'
            )}
          </p>
        )}

        <p className='text-muted-foreground text-sm'>
          {t(
            'Select documents and fill in the model and API token above. Up to 120,000 characters per analysis.'
          )}
        </p>
        {valid && (
          <p className='text-sm'>
            {t(
              'At least {{count}} model requests; each is billed by token usage.',
              { count: formatNumber(sourceCount + 1, locale) }
            )}
          </p>
        )}
        <div className='flex flex-wrap gap-2'>
          <Button
            type='button'
            disabled={blocked}
            onClick={() => start('summary')}
          >
            {t('Summarize all notes')}
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={blocked}
            onClick={() => start('rules')}
          >
            {t('Extract experience cards')}
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={blocked || props.selected.length < 2}
            onClick={() => start('compare')}
          >
            {t('Compare notes')}
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
        {props.selected.length > 0 && !valid && (
          <p role='alert'>
            {t(
              'Select nonempty documents totaling at most 120,000 characters.'
            )}
          </p>
        )}
        {job.isPending && (
          <p role='status'>
            {t('Analysis progress: {{done}} / {{total}} requests', {
              done: formatNumber(progress.done, locale),
              total: formatNumber(progress.total, locale),
            })}
          </p>
        )}
        {error && (
          <p role='alert' className='text-destructive'>
            {error}
          </p>
        )}
        {savedReports.length > 0 && (
          <div className='space-y-2'>
            <Label>{t('Saved research results')}</Label>
            <div className='flex flex-wrap gap-2'>
              {savedReports.map((document) => (
                <Button
                  type='button'
                  key={document.id}
                  variant='outline'
                  disabled={job.isPending || props.disabled}
                  onClick={() => {
                    setReport(readReport(document.text))
                    setKnowledgeBase(document.knowledge_base ?? '')
                    setTitle(document.name)
                    setRevision((value) => value + 1)
                  }}
                >
                  {document.name}
                </Button>
              ))}
            </div>
          </div>
        )}
        {report && ownerId && (
          <ReportEditor
            key={`${ownerId}:${revision}`}
            report={report}
            title={title}
            documents={props.documents}
            ownerId={ownerId}
            knowledgeBase={knowledgeBase}
            disabled={props.disabled || job.isPending}
          />
        )}
      </CardContent>
    </Card>
  )
}
