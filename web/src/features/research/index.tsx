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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownRight,
  BookOpenText,
  ChartNoAxesCombined,
  FileText,
  Send,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
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
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { FXReference } from './fx-reference'
import { KnowledgeLibrary } from './knowledge-library'
import type { KnowledgeMetadata } from './knowledge-metadata'
import { KnowledgeSearch } from './knowledge-search'
import { MomentumScreen } from './momentum-screen'
import { QuantBacktest } from './quant-backtest'
import { ResearchActions } from './research-actions'
import { readReport, type SavedDocument } from './research-workflow'
import { SourceDialog } from './source-dialog'

type ExtractResponse = {
  success: boolean
  data?: { name: string; text: string }
}

export function ResearchAssistant() {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  const [model, setModel] = useState('deepseek-flash')
  const [question, setQuestion] = useState('')
  const questionRef = useRef<HTMLTextAreaElement>(null)
  const [analysisContext, setAnalysisContext] = useState('')
  const [researchBusy, setResearchBusy] = useState(false)
  const [scope, setScope] = useState('*')
  const [viewedDocument, setViewedDocument] = useState<SavedDocument | null>(
    null
  )
  const userId = useAuthStore((state) => state.auth.user?.id)
  const queryClient = useQueryClient()
  const queryKey = ['knowledge-documents', userId]
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [pendingDelete, setPendingDelete] = useState<SavedDocument | null>(null)
  useEffect(() => {
    setSelectedIds([])
    setScope('*')
    setAnalysisContext('')
    setToken('')
    setAnswer('')
    setViewedDocument(null)
  }, [userId])
  const documents = useQuery({
    queryKey,
    enabled: !!userId,
    gcTime: 0,
    meta: { errorToast: false },
    queryFn: async () => {
      const response = await api.get<{
        success: boolean
        data?: SavedDocument[]
      }>('/api/knowledge/documents')
      return requireServerSuccess(response.data).data ?? []
    },
  })
  const selectedDocuments = useMemo(
    () =>
      (documents.data ?? []).filter(
        (item) =>
          selectedIds.includes(item.id) &&
          (scope === '*' || (item.knowledge_base ?? '') === scope)
      ),
    [documents.data, selectedIds, scope]
  )
  const knowledgeDocuments = useMemo(
    () =>
      (documents.data ?? []).filter(
        (item) =>
          (scope === '*' || (item.knowledge_base ?? '') === scope) &&
          item.document_type !== 'report' &&
          !readReport(item.text)
      ),
    [documents.data, scope]
  )
  const searchDocuments = useMemo(() => {
    const sources = selectedDocuments.filter(
      (doc) => doc.document_type !== 'report' && !readReport(doc.text)
    )
    return sources.length ? sources : knowledgeDocuments
  }, [selectedDocuments, knowledgeDocuments])
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const extract = useMutation({
    meta: { errorToast: false },
    mutationFn: async ({
      files,
      metadata,
      ownerId,
    }: {
      files: File[]
      metadata: KnowledgeMetadata
      ownerId: number
    }) => {
      if (files.length + (documents.data?.length ?? 0) > 20) {
        throw new Error('Document limit reached')
      }
      for (const file of files) {
        if (useAuthStore.getState().auth.user?.id !== ownerId) {
          throw new Error('Account changed')
        }
        const form = new FormData()
        form.append('file', file)
        const response = await api.post<ExtractResponse>(
          '/api/knowledge/extract',
          form
        )
        const data = requireServerSuccess(response.data).data
        if (!data) throw new Error('Missing document')
        if (useAuthStore.getState().auth.user?.id !== ownerId) {
          throw new Error('Account changed')
        }
        const savedResponse = await api.post<{
          success: boolean
          data?: SavedDocument
        }>('/api/knowledge/documents', {
          ...data,
          ...metadata,
          owner_id: ownerId,
        })
        const saved = requireServerSuccess(savedResponse.data).data
        if (!saved) throw new Error('Missing saved document')
        if (useAuthStore.getState().auth.user?.id !== ownerId) {
          throw new Error('Account changed')
        }
        queryClient.setQueryData<SavedDocument[]>(
          ['knowledge-documents', ownerId],
          (old) => [
            saved,
            ...(old ?? []).filter((item) => item.id !== saved.id),
          ]
        )
        setSelectedIds((old) => [...old, saved.id])
        setScope(saved.knowledge_base ?? metadata.knowledge_base)
      }
    },
    onMutate: async (variables) => {
      setError('')
      await queryClient.cancelQueries({
        queryKey: ['knowledge-documents', variables.ownerId],
      })
    },
    onSettled: (_data, _error, variables) => {
      if (useAuthStore.getState().auth.user?.id === variables.ownerId) {
        void queryClient.invalidateQueries({
          queryKey: ['knowledge-documents', variables.ownerId],
        })
      }
    },
    onError: () => setError(t('Unable to read or save the document')),
  })
  const removeDocument = useMutation({
    meta: { errorToast: false },
    mutationFn: async ({ id, ownerId }: { id: number; ownerId: number }) => {
      if (useAuthStore.getState().auth.user?.id !== ownerId) {
        throw new Error('Account changed')
      }
      const response = await api.delete(`/api/knowledge/documents/${id}`)
      requireServerSuccess(response.data)
    },
    onSuccess: (_result, variables) => {
      if (useAuthStore.getState().auth.user?.id !== variables.ownerId) return
      setSelectedIds((old) => old.filter((id) => id !== variables.id))
      setAnswer('')
      setPendingDelete(null)
      queryClient.setQueryData<SavedDocument[]>(
        ['knowledge-documents', variables.ownerId],
        (old) => (old ?? []).filter((item) => item.id !== variables.id)
      )
    },
    onError: () => setError(t('Unable to delete the document')),
  })
  const assistant = useMutation({
    meta: { errorToast: false },
    mutationFn: async (_ownerId: number) => {
      if (
        !token.trim() ||
        !model.trim() ||
        !question.trim() ||
        (selectedDocuments.length === 0 && !analysisContext)
      ) {
        throw new Error('Missing input')
      }
      const response = await fetch('/v1/agent/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token.trim()}`,
        },
        body: JSON.stringify({
          model: model.trim(),
          question,
          context: analysisContext,
          max_tokens: 512,
          reasoning_effort: model.trim().toLowerCase().startsWith('deepseek-')
            ? 'none'
            : undefined,
          documents: selectedDocuments.map((item) => ({
            id: String(item.id),
            name: item.name,
            text: item.text,
          })),
        }),
      })
      if (!response.ok) throw new Error('Assistant request failed')
      const result: { choices?: { message?: { content?: string } }[] } =
        await response.json()
      const content = result.choices?.[0]?.message?.content
      if (!content) throw new Error('Missing answer')
      return content
    },
    onMutate: () => {
      setError('')
      setAnswer('')
    },
    onSuccess: (content, ownerId) => {
      if (useAuthStore.getState().auth.user?.id === ownerId) setAnswer(content)
    },
    onError: (_error, ownerId) => {
      if (useAuthStore.getState().auth.user?.id === ownerId) {
        setError(t('Unable to complete the request'))
      }
    },
  })
  const pending =
    extract.isPending ||
    assistant.isPending ||
    removeDocument.isPending ||
    researchBusy
  function ask() {
    if (
      !userId ||
      !token.trim() ||
      !model.trim() ||
      !question.trim() ||
      (selectedDocuments.length === 0 && !analysisContext)
    ) {
      setError(t('Enter a model, API token, question and at least one source'))
      return
    }
    assistant.mutate(userId)
  }

  return (
    <div className='mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-10 lg:py-10'>
      <header className='relative overflow-hidden rounded-3xl border border-sky-200/60 bg-gradient-to-br from-sky-50 via-white to-cyan-50/80 px-6 py-7 sm:px-9 sm:py-9 dark:border-sky-900/60 dark:from-slate-900 dark:via-slate-950 dark:to-sky-950/60'>
        <div
          aria-hidden='true'
          className='pointer-events-none absolute -top-24 -right-12 size-64 rounded-full bg-sky-300/20 blur-3xl'
        />
        <div className='relative max-w-3xl space-y-3'>
          <div className='flex items-center gap-2 text-xs font-semibold tracking-[0.16em] text-sky-700 uppercase dark:text-sky-300'>
            <Sparkles className='size-4' /> {t('Research workspace')}
          </div>
          <h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
            {t('Research workspace title')}
          </h1>
          <p className='text-muted-foreground max-w-2xl text-sm leading-6'>
            {t('Research workspace description')}
          </p>
        </div>
        <nav
          aria-label={t('Research tools')}
          className='relative mt-6 flex flex-wrap gap-2'
        >
          <a
            href='#research-assistant'
            className='inline-flex items-center gap-2 rounded-full border border-sky-200 bg-white/80 px-3.5 py-2 text-xs font-medium text-sky-900 transition hover:border-sky-400 dark:border-sky-800 dark:bg-slate-900 dark:text-sky-100'
          >
            <BookOpenText className='size-4' />
            {t('Personal knowledge base')}
          </a>
          <a
            href='#knowledge-organization'
            className='bg-background/70 hover:bg-background inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition'
          >
            {t('Knowledge organization agent')}
          </a>
          <a
            href='#knowledge-search'
            className='bg-background/70 hover:bg-background inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition'
          >
            {t('Search your knowledge base')}
          </a>
          <a
            href='#research-backtest'
            className='bg-background/70 hover:bg-background inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition'
          >
            <ChartNoAxesCombined className='size-4' />
            {t('A-share backtest preview')}
          </a>
          <a
            href='#research-fx'
            className='bg-background/70 hover:bg-background inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition'
          >
            {t('FX research tools')}
          </a>
          <a
            href='#research-screen'
            className='bg-background/70 hover:bg-background inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition'
          >
            <ArrowDownRight className='size-4' />
            {t('Local momentum screening')}
          </a>
        </nav>
      </header>
      <Card
        id='research-assistant'
        className='scroll-mt-4 gap-0 rounded-2xl border-0 py-0 shadow-sm'
      >
        <CardHeader className='border-b px-6 py-5 sm:px-7'>
          <CardTitle className='flex items-center gap-3 text-lg font-semibold'>
            <span className='flex size-10 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300'>
              <FileText className='size-5' />
            </span>
            {t('Personal knowledge base')}
          </CardTitle>
          <CardDescription>
            {t(
              'Upload your own documents, group them into knowledge bases, and let the agent organize topics, evidence and differences.'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className='grid gap-0 px-0 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]'>
          <div className='space-y-4 border-b p-6 sm:p-7 lg:border-r lg:border-b-0'>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Documents are saved to your account. Relevant excerpts are sent to the model provider; review answers and citations before relying on them.'
              )}
            </p>
            <details className='text-muted-foreground text-xs leading-5'>
              <summary className='cursor-pointer font-medium'>
                {t('Document requirements')}
              </summary>
              <p className='mt-2'>
                {t(
                  'Up to 20 documents; each text may contain at most 100,000 characters. The combined request must be under 3 MB.'
                )}
              </p>
              <p className='text-muted-foreground text-sm'>
                {t('Scanned PDF files require OCR and are not supported yet.')}
              </p>
            </details>
            <div className='space-y-2'>
              <Label htmlFor='research-token'>{t('API token')}</Label>
              <Input
                id='research-token'
                type='password'
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete='off'
                disabled={pending}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='research-model'>{t('Model')}</Label>
              <Input
                id='research-model'
                value={model}
                disabled={pending}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <KnowledgeLibrary
              key={userId ?? 'anonymous'}
              documents={documents.data ?? []}
              ownerId={userId}
              scope={scope}
              onScopeChange={setScope}
              selectedIds={selectedIds}
              onSelect={(id) =>
                setSelectedIds((old) =>
                  old.includes(id)
                    ? old.filter((item) => item !== id)
                    : [...old, id]
                )
              }
              pending={pending}
              loading={documents.isLoading}
              error={documents.isError}
              onUpload={(files, metadata) => {
                if (userId) extract.mutate({ files, metadata, ownerId: userId })
              }}
              onView={setViewedDocument}
              onDelete={setPendingDelete}
            />
          </div>
          <div className='flex flex-col gap-4 bg-slate-50/50 p-6 sm:p-7 dark:bg-slate-900/20'>
            <div className='space-y-2'>
              <Label htmlFor='research-question'>{t('Question')}</Label>
              <Textarea
                id='research-question'
                className='bg-background min-h-40 resize-y'
                placeholder={t('Ask about your documents or attached results')}
                ref={questionRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </div>
            {analysisContext && (
              <div className='space-y-2'>
                <p role='status' className='text-sm'>
                  {t(
                    'A calculation result is attached and will be sent to the model provider.'
                  )}
                </p>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => setAnalysisContext('')}
                >
                  {t('Remove attachment')}
                </Button>
              </div>
            )}
            {error && (
              <p role='alert' className='text-destructive text-sm'>
                {error}
              </p>
            )}
            <Button
              className='h-10 self-start px-5'
              disabled={pending}
              onClick={ask}
            >
              <Send className='size-4' />
              {pending ? t('Processing...') : t('Ask assistant')}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ResearchActions
        key={userId ?? 'anonymous'}
        documents={documents.data ?? []}
        selected={selectedDocuments}
        corpus={knowledgeDocuments}
        scope={scope}
        token={token}
        model={model}
        disabled={
          extract.isPending ||
          assistant.isPending ||
          removeDocument.isPending ||
          documents.isLoading ||
          documents.isError
        }
        onBusyChange={setResearchBusy}
      />
      <KnowledgeSearch
        key={`search:${userId ?? 'anonymous'}`}
        documents={searchDocuments}
        allDocuments={documents.data ?? []}
        token={token}
        model={model}
        disabled={pending}
        onBusyChange={setResearchBusy}
      />
      <SourceDialog
        document={viewedDocument}
        onClose={() => setViewedDocument(null)}
      />
      {answer && (
        <Card className='rounded-2xl border-0 py-5 shadow-sm'>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-lg font-semibold'>
              <Sparkles className='size-5 text-sky-600' />
              {t('Answer')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className='whitespace-pre-wrap'>{answer}</p>
          </CardContent>
        </Card>
      )}
      <FXReference
        key={`fx:${userId ?? 'anonymous'}`}
        disabled={pending}
        onAnalyze={(context) => {
          setAnalysisContext(context)
          setQuestion(
            t(
              'Explain the attached FX calculation alongside the selected documents. Distinguish published facts, user views and uncertainty.'
            )
          )
          setAnswer('')
          setError('')
          questionRef.current?.focus()
        }}
      />
      <div id='research-backtest' className='scroll-mt-4'>
        <QuantBacktest
          onAnalyze={(context) => {
            setAnalysisContext(context)
            setQuestion(
              t('Explain the attached calculation and its limitations.')
            )
            setAnswer('')
            setError('')
            questionRef.current?.focus()
          }}
        />
      </div>
      <div id='research-screen' className='scroll-mt-4'>
        <MomentumScreen
          onAnalyze={(context) => {
            setAnalysisContext(context)
            setQuestion(
              t('Explain the attached calculation and its limitations.')
            )
            setAnswer('')
            setError('')
            questionRef.current?.focus()
          }}
        />
      </div>
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={t('Delete document?')}
        desc={t(
          'This permanently deletes the saved document from your account.'
        )}
        confirmText={t('Delete')}
        destructive
        isLoading={removeDocument.isPending}
        handleConfirm={() => {
          if (pendingDelete && userId) {
            removeDocument.mutate({ id: pendingDelete.id, ownerId: userId })
          }
        }}
      />
    </div>
  )
}
