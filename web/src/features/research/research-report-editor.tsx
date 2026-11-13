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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Markdown } from '@/components/ui/markdown'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import {
  serializeReport,
  type ResearchReport,
  type ResearchSource,
  type SavedDocument,
} from './research-workflow'
import { SourceDialog } from './source-dialog'

const editSchema = z.object({
  title: z.string().trim().min(1).max(255),
  body: z.string().trim().min(1).max(90000),
})
export function ReportEditor(props: {
  report: ResearchReport
  title: string
  documents: SavedDocument[]
  ownerId: number
  knowledgeBase?: string
  disabled: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [preview, setPreview] = useState(false)
  const [source, setSource] = useState<ResearchSource | null>(null)
  const [saved, setSaved] = useState(false)
  const form = useForm<z.infer<typeof editSchema>>({
    resolver: zodResolver(editSchema),
    defaultValues: { title: props.title, body: props.report.body },
  })
  const body = form.watch('body')
  const save = useMutation({
    meta: { errorToast: false },
    mutationFn: async (values: z.infer<typeof editSchema>) => {
      if (useAuthStore.getState().auth.user?.id !== props.ownerId) {
        throw new Error('Account changed')
      }
      const response = await api.post<{
        success: boolean
        data?: SavedDocument
      }>('/api/knowledge/documents', {
        name: values.title,
        text: serializeReport({ ...props.report, body: values.body }),
        owner_id: props.ownerId,
        knowledge_base: props.knowledgeBase ?? '',
        document_type: 'report',
      })
      const document = requireServerSuccess(response.data).data
      if (!document) throw new Error('Missing saved report')
      return document
    },
    onSuccess: (document) => {
      if (useAuthStore.getState().auth.user?.id !== props.ownerId) return
      queryClient.setQueryData<SavedDocument[]>(
        ['knowledge-documents', props.ownerId],
        (old) => [document, ...(old ?? [])]
      )
      setSaved(true)
    },
    onError: (error) =>
      handleServerError(error, t('Unable to save research result')),
  })
  const sourceDocument =
    props.documents.find((item) => item.id === source?.documentId) ?? null
  return (
    <form
      className='space-y-4'
      onChange={() => setSaved(false)}
      onSubmit={form.handleSubmit((values) => save.mutate(values))}
    >
      <Label htmlFor='research-result-title'>{t('Result title')}</Label>
      <Input
        id='research-result-title'
        disabled={props.disabled || save.isPending}
        aria-invalid={!!form.formState.errors.title}
        {...form.register('title')}
      />
      {form.formState.errors.title && (
        <p role='alert'>{t('Enter a title of 1–255 characters')}</p>
      )}
      <div className='flex flex-wrap gap-2'>
        <Button
          type='button'
          variant='outline'
          aria-pressed={preview}
          onClick={() => setPreview(!preview)}
        >
          {t('Preview')}
        </Button>
        <CopyButton value={body} />
      </div>
      <Label htmlFor='research-result-body'>{t('Edit research result')}</Label>
      {preview ? (
        <Markdown>{body}</Markdown>
      ) : (
        <Textarea
          id='research-result-body'
          className='min-h-64'
          disabled={props.disabled || save.isPending}
          aria-invalid={!!form.formState.errors.body}
          {...form.register('body')}
        />
      )}
      {form.formState.errors.body && (
        <p role='alert'>{t('Enter a result of 1–90,000 characters')}</p>
      )}
      <p className='text-muted-foreground text-sm'>
        {t(
          'Each save creates a new document in your account. Sources remain linked to their original documents.'
        )}
      </p>
      <Button
        type='submit'
        disabled={
          props.disabled ||
          save.isPending ||
          props.documents.length >= 20 ||
          saved
        }
      >
        {save.isPending ? t('Processing...') : t('Save as new document')}
      </Button>
      {props.documents.length >= 20 && (
        <p role='alert'>
          {t('Document limit reached (20). Remove a document before saving.')}
        </p>
      )}
      {saved && <p role='status'>{t('Research result saved')}</p>}
      {save.isError && (
        <p role='alert'>{t('Unable to save research result')}</p>
      )}
      <div className='space-y-2'>
        <p className='font-medium'>{t('Analyzed sources')}</p>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Source markers identify analyzed passages. Verify claims against the original text.'
          )}
        </p>
        <div className='flex max-h-48 flex-wrap gap-2 overflow-y-auto'>
          {props.report.sources.map((item) => (
            <Button
              key={item.id}
              type='button'
              variant='outline'
              className='max-w-full'
              disabled={
                !props.documents.some(
                  (document) => document.id === item.documentId
                )
              }
              onClick={() => setSource(item)}
            >
              <span className='truncate'>
                [{item.id}] {item.name}
              </span>
              {!props.documents.some(
                (document) => document.id === item.documentId
              ) && t('Source unavailable')}
            </Button>
          ))}
        </div>
      </div>
      <SourceDialog
        document={sourceDocument}
        source={source ?? undefined}
        onClose={() => setSource(null)}
      />
    </form>
  )
}
