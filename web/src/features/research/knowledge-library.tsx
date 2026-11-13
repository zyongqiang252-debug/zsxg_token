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
import { useForm, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { toIntlLocale } from '@/i18n/languages'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

import {
  emptyMetadata,
  metadataFields,
  metadataSchema,
  type KnowledgeMetadata,
} from './knowledge-metadata'
import type { SavedDocument } from './research-workflow'

function MetadataFields(props: {
  form: UseFormReturn<KnowledgeMetadata>
  prefix: string
  disabled: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className='grid gap-3 sm:grid-cols-2'>
      {metadataFields.map((field) => (
        <div key={field.key} className='space-y-1'>
          <Label htmlFor={`${props.prefix}-${field.key}`}>
            {t(field.label)}
          </Label>
          {field.key === 'conditions' ? (
            <Textarea
              id={`${props.prefix}-${field.key}`}
              disabled={props.disabled}
              maxLength={field.limit}
              {...props.form.register(field.key)}
            />
          ) : (
            <Input
              id={`${props.prefix}-${field.key}`}
              type={field.key === 'document_date' ? 'date' : 'text'}
              disabled={props.disabled}
              maxLength={field.limit}
              {...props.form.register(field.key)}
            />
          )}
          {props.form.formState.errors[field.key] && (
            <p role='alert'>{t('Invalid document metadata')}</p>
          )}
        </div>
      ))}
    </div>
  )
}

function MetadataEditor(props: {
  document: SavedDocument
  ownerId: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const form = useForm<KnowledgeMetadata>({
    resolver: zodResolver(metadataSchema),
    defaultValues: {
      ...emptyMetadata,
      ...Object.fromEntries(
        metadataFields.map((field) => [
          field.key,
          props.document[field.key] ?? '',
        ])
      ),
    },
  })
  const update = useMutation({
    meta: { errorToast: false },
    mutationFn: async (values: KnowledgeMetadata) => {
      if (useAuthStore.getState().auth.user?.id !== props.ownerId) {
        throw new Error('Account changed')
      }
      const response = await api.put<{
        success: boolean
        data?: SavedDocument
      }>(`/api/knowledge/documents/${props.document.id}/metadata`, {
        ...values,
        owner_id: props.ownerId,
      })
      const document = requireServerSuccess(response.data).data
      if (!document) throw new Error('Missing updated document')
      return document
    },
    onSuccess: (document) => {
      if (useAuthStore.getState().auth.user?.id !== props.ownerId) return
      queryClient.setQueryData<SavedDocument[]>(
        ['knowledge-documents', props.ownerId],
        (old) =>
          (old ?? []).map((item) => (item.id === document.id ? document : item))
      )
      props.onClose()
    },
    onError: (error) =>
      handleServerError(error, t('Unable to save document metadata')),
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !update.isPending) props.onClose()
      }}
      title={t('Edit document metadata')}
      description={props.document.name}
    >
      <form
        className='space-y-4'
        onSubmit={form.handleSubmit((values) => update.mutate(values))}
      >
        <MetadataFields
          form={form}
          prefix='edit-metadata'
          disabled={update.isPending}
        />
        {update.isError && (
          <p role='alert'>{t('Unable to save document metadata')}</p>
        )}
        <Button type='submit' disabled={update.isPending}>
          {update.isPending ? t('Processing...') : t('Save')}
        </Button>
      </form>
    </Dialog>
  )
}

export function KnowledgeLibrary(props: {
  documents: SavedDocument[]
  ownerId: number | undefined
  scope: string
  onScopeChange: (scope: string) => void
  selectedIds: number[]
  onSelect: (id: number) => void
  pending: boolean
  loading: boolean
  error: boolean
  onUpload: (files: File[], metadata: KnowledgeMetadata) => void
  onView: (document: SavedDocument) => void
  onDelete: (document: SavedDocument) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [filter, setFilter] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [editing, setEditing] = useState<SavedDocument | null>(null)
  const upload = useForm<KnowledgeMetadata>({
    resolver: zodResolver(metadataSchema),
    defaultValues: emptyMetadata,
  })
  const bases = [
    ...new Set([
      ...props.documents.map((doc) => doc.knowledge_base ?? ''),
      ...(props.scope === '*' ? [] : [props.scope]),
    ]),
  ].sort()
  const scoped = props.documents.filter(
    (doc) => props.scope === '*' || (doc.knowledge_base ?? '') === props.scope
  )
  const visible = scoped.filter((doc) =>
    [doc.name, doc.author, doc.topic, doc.instrument, doc.conditions].some(
      (value) => value?.toLowerCase().includes(filter.trim().toLowerCase())
    )
  )
  return (
    <div className='space-y-3'>
      <Label htmlFor='knowledge-scope'>{t('Current knowledge base')}</Label>
      <NativeSelect
        id='knowledge-scope'
        value={props.scope}
        disabled={props.pending}
        onChange={(event) => {
          props.onScopeChange(event.target.value)
          upload.setValue(
            'knowledge_base',
            event.target.value === '*' ? '' : event.target.value
          )
        }}
      >
        <NativeSelectOption value='*'>
          {t('All knowledge bases')}
        </NativeSelectOption>
        {bases.map((base) => (
          <NativeSelectOption key={base} value={base}>
            {base || t('Uncategorized')}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <details>
        <summary className='cursor-pointer text-sm font-medium'>
          {t('Metadata for uploaded documents')}
        </summary>
        <div className='mt-3'>
          <MetadataFields
            form={upload}
            prefix='upload-metadata'
            disabled={props.pending}
          />
        </div>
      </details>
      <Label htmlFor='research-file'>{t('Document')}</Label>
      <Input
        id='research-file'
        type='file'
        multiple
        accept='.txt,.md,.docx,.pdf'
        disabled={
          props.pending ||
          props.loading ||
          props.error ||
          !props.ownerId ||
          props.documents.length >= 20
        }
        onChange={async (event) => {
          const element = event.currentTarget
          const files = [...(element.files ?? [])]
          setUploadError('')
          if (files.length + props.documents.length > 20) {
            setUploadError(
              t('Document limit reached (20). Remove a document before saving.')
            )
            element.value = ''
            return
          }
          if (files.length) {
            const values = metadataSchema.safeParse(upload.getValues())
            if (values.success) {
              upload.clearErrors()
              props.onUpload(files, values.data)
            } else {
              await upload.trigger()
            }
          }
          element.value = ''
        }}
      />
      {(uploadError || props.documents.length >= 20) && (
        <p role='alert'>
          {uploadError ||
            t('Document limit reached (20). Remove a document before saving.')}
        </p>
      )}
      {props.error && <p role='alert'>{t('Unable to load documents')}</p>}
      <Label htmlFor='knowledge-filter'>{t('Filter documents')}</Label>
      <Input
        id='knowledge-filter'
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={t('Search names, authors, topics or conditions')}
      />
      {visible.map((item) => (
        <div
          key={item.id}
          className='bg-muted/30 space-y-2 rounded-xl border p-2'
        >
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              type='button'
              className='min-w-0 flex-1 justify-start'
              variant={
                props.selectedIds.includes(item.id) ? 'default' : 'outline'
              }
              aria-pressed={props.selectedIds.includes(item.id)}
              disabled={props.pending}
              onClick={() => props.onSelect(item.id)}
            >
              <span className='truncate' title={item.name}>
                {item.name}
              </span>
            </Button>
            <Button
              type='button'
              variant='outline'
              aria-label={`${t('View original')}: ${item.name}`}
              onClick={() => props.onView(item)}
            >
              {t('View original')}
            </Button>
            <Button
              type='button'
              variant='outline'
              aria-label={`${t('Edit document metadata')}: ${item.name}`}
              disabled={props.pending}
              onClick={() => setEditing(item)}
            >
              {t('Edit')}
            </Button>
            <Button
              type='button'
              variant='outline'
              aria-label={`${t('Delete document')}: ${item.name}`}
              disabled={props.pending}
              onClick={() => props.onDelete(item)}
            >
              {t('Delete')}
            </Button>
          </div>
          <p className='text-muted-foreground text-xs break-words'>
            {[
              item.knowledge_base,
              item.author,
              item.document_date,
              item.topic,
              item.instrument,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      ))}
      {!props.loading && !props.error && visible.length === 0 && (
        <p role='status'>{t('No matching documents')}</p>
      )}
      <p className='text-sm'>
        {t('Selected documents')}:{' '}
        {formatNumber(
          scoped.filter((doc) => props.selectedIds.includes(doc.id)).length,
          locale
        )}
      </p>
      {editing && props.ownerId && (
        <MetadataEditor
          key={editing.id}
          document={editing}
          ownerId={props.ownerId}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
