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
import { useEffect, useRef, useState } from 'react'
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
import { toIntlLocale } from '@/i18n/languages'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import { MomentumScreen } from './momentum-screen'
import { QuantBacktest } from './quant-backtest'

type SavedDocument = { id: number; name: string; text: string }
type ExtractResponse = {
  success: boolean
  data?: { name: string; text: string }
}

export function ResearchAssistant() {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [token, setToken] = useState('')
  const [model, setModel] = useState('deepseek-flash')
  const [question, setQuestion] = useState('')
  const questionRef = useRef<HTMLTextAreaElement>(null)
  const [analysisContext, setAnalysisContext] = useState('')
  const userId = useAuthStore((state) => state.auth.user?.id)
  const queryClient = useQueryClient()
  const queryKey = ['knowledge-documents', userId]
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [pendingDelete, setPendingDelete] = useState<SavedDocument | null>(null)
  useEffect(() => {
    setSelectedIds([])
    setAnalysisContext('')
    setToken('')
    setAnswer('')
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
  const selectedDocuments = (documents.data ?? []).filter((item) =>
    selectedIds.includes(item.id)
  )
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const extract = useMutation({
    meta: { errorToast: false },
    mutationFn: async ({ file, ownerId }: { file: File; ownerId: number }) => {
      const form = new FormData()
      form.append('file', file)
      const response = await api.post<ExtractResponse>(
        '/api/knowledge/extract',
        form
      )
      const data = requireServerSuccess(response.data)
      if (!data.data) throw new Error('Missing document')
      if (useAuthStore.getState().auth.user?.id !== ownerId) {
        throw new Error('Account changed')
      }
      const saved = await api.post<{ success: boolean; data?: SavedDocument }>(
        '/api/knowledge/documents',
        { ...data.data, owner_id: ownerId }
      )
      const savedData = requireServerSuccess(saved.data)
      if (!savedData.data) throw new Error('Missing saved document')
      return savedData.data
    },
    onMutate: async (variables) => {
      setError('')
      await queryClient.cancelQueries({
        queryKey: ['knowledge-documents', variables.ownerId],
      })
    },
    onSuccess: (saved, variables) => {
      if (useAuthStore.getState().auth.user?.id !== variables.ownerId) return
      queryClient.setQueryData<SavedDocument[]>(
        ['knowledge-documents', variables.ownerId],
        (old) => [saved, ...(old ?? []).filter((item) => item.id !== saved.id)]
      )
      setSelectedIds((old) => [...old, saved.id])
      void queryClient.invalidateQueries({
        queryKey: ['knowledge-documents', variables.ownerId],
      })
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
    extract.isPending || assistant.isPending || removeDocument.isPending
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
    <div className='mx-auto w-full max-w-3xl space-y-6 p-6'>
      <Card>
        <CardHeader>
          <CardTitle>{t('Document research assistant')}</CardTitle>
          <CardDescription>
            {t(
              'Upload a text, Markdown, DOCX or text-based PDF file and ask a question. Relevant excerpts are sent to the selected model and billed by token usage.'
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-4'>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Documents are saved to your account. Relevant excerpts are sent to the model provider; review answers and citations before relying on them.'
            )}
          </p>
          <p className='text-muted-foreground text-sm'>
            {t(
              'Up to 20 documents; each text may contain at most 100,000 characters. The combined request must be under 3 MB.'
            )}
          </p>
          <p className='text-muted-foreground text-sm'>
            {t('Scanned PDF files require OCR and are not supported yet.')}
          </p>
          <div className='space-y-2'>
            <Label htmlFor='research-token'>{t('API token')}</Label>
            <Input
              id='research-token'
              type='password'
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete='off'
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='research-model'>{t('Model')}</Label>
            <Input
              id='research-model'
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='research-file'>{t('Document')}</Label>
            <Input
              id='research-file'
              type='file'
              accept='.txt,.md,.docx,.pdf'
              disabled={
                pending || documents.isLoading || documents.isError || !userId
              }
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file && userId) extract.mutate({ file, ownerId: userId })
              }}
            />
            {documents.isError && (
              <p role='alert'>{t('Unable to load documents')}</p>
            )}
            {(documents.data ?? []).map((item) => (
              <div key={item.id} className='flex items-center gap-2'>
                <Button
                  type='button'
                  variant={
                    selectedIds.includes(item.id) ? 'default' : 'outline'
                  }
                  aria-pressed={selectedIds.includes(item.id)}
                  onClick={() =>
                    setSelectedIds((old) =>
                      old.includes(item.id)
                        ? old.filter((id) => id !== item.id)
                        : [...old, item.id]
                    )
                  }
                >
                  {item.name}
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  aria-label={`${t('Delete document')}: ${item.name}`}
                  onClick={() => setPendingDelete(item)}
                >
                  {t('Delete')}
                </Button>
              </div>
            ))}
            <p className='text-sm'>
              {t('Selected documents')}:{' '}
              {formatNumber(selectedDocuments.length, locale)}
            </p>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='research-question'>{t('Question')}</Label>
            <Textarea
              id='research-question'
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
          <Button disabled={pending} onClick={ask}>
            {pending ? t('Processing...') : t('Ask assistant')}
          </Button>
        </CardContent>
      </Card>
      {answer && (
        <Card>
          <CardHeader>
            <CardTitle>{t('Answer')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className='whitespace-pre-wrap'>{answer}</p>
          </CardContent>
        </Card>
      )}
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
