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
import { useMutation } from '@tanstack/react-query'
import { ArrowRightLeft } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { api } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import {
  getServerErrorMessage,
  requireServerSuccess,
} from '@/lib/server-error-message'

import { FXReferenceResult } from './fx-reference-result'
import {
  fxCurrencies,
  fxSchema,
  type FXInput,
  type FXResult,
} from './lib/fx-reference'

export function FXReference(props: {
  onAnalyze?: (context: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const form = useForm<FXInput>({
    resolver: zodResolver(fxSchema),
    defaultValues: {
      base: 'USD',
      quote: 'CNY',
      amount: '1000',
      from: dayjs().subtract(30, 'day').format('YYYY-MM-DD'),
      to: dayjs().format('YYYY-MM-DD'),
    },
  })
  const query = useMutation({
    meta: { errorToast: false },
    mutationFn: async (input: FXInput) => {
      const response = await api.post<{ success: boolean; data?: FXResult }>(
        '/api/fx/reference',
        input
      )
      const result = requireServerSuccess(response.data).data
      if (!result) {
        throw new Error('Reference rate service returned invalid data.')
      }
      return result
    },
  })
  const busy = query.isPending || props.disabled
  return (
    <Card
      id='research-fx'
      className='scroll-mt-24 gap-0 rounded-2xl border-0 py-0 shadow-sm'
    >
      <CardHeader className='border-b px-6 py-5 sm:px-7'>
        <CardTitle className='flex items-center gap-3 text-lg font-semibold'>
          <ArrowRightLeft aria-hidden='true' className='size-5 text-sky-600' />
          {t('FX research tools')}
        </CardTitle>
        <CardDescription>
          {t(
            'Compare historical reference rates, convert an amount, and explain the result with your knowledge base.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-5 p-6 sm:p-7'>
        <p className='text-muted-foreground text-sm'>
          {t(
            'ECB reference data via Frankfurter. Publication days only; not live quotes or bank transaction rates.'
          )}
        </p>
        <form
          onSubmit={form.handleSubmit((input) => query.mutate(input))}
          onChange={() => query.reset()}
          className='space-y-4'
          noValidate
        >
          <FieldSet disabled={busy}>
            <FieldLegend className='sr-only'>{t('FX query')}</FieldLegend>
            <FieldGroup className='grid gap-4 sm:grid-cols-2 lg:grid-cols-5'>
              <Field>
                <FieldLabel htmlFor='fx-base'>{t('Base currency')}</FieldLabel>
                <NativeSelect
                  id='fx-base'
                  className='w-full'
                  {...form.register('base')}
                >
                  {fxCurrencies.map((code) => (
                    <NativeSelectOption key={code} value={code}>
                      {code}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor='fx-quote'>
                  {t('Quote currency')}
                </FieldLabel>
                <NativeSelect
                  id='fx-quote'
                  className='w-full'
                  {...form.register('quote')}
                >
                  {fxCurrencies.map((code) => (
                    <NativeSelectOption key={code} value={code}>
                      {code}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor='fx-amount'>
                  {t('Amount in base currency')}
                </FieldLabel>
                <Input
                  id='fx-amount'
                  inputMode='decimal'
                  aria-invalid={!!form.formState.errors.amount}
                  {...form.register('amount')}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor='fx-from'>{t('From date')}</FieldLabel>
                <Input
                  id='fx-from'
                  type='date'
                  min='1999-01-04'
                  max={dayjs().format('YYYY-MM-DD')}
                  aria-invalid={!!form.formState.errors.from}
                  {...form.register('from')}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor='fx-to'>{t('To date')}</FieldLabel>
                <Input
                  id='fx-to'
                  type='date'
                  min='1999-01-04'
                  max={dayjs().format('YYYY-MM-DD')}
                  aria-invalid={!!form.formState.errors.to}
                  {...form.register('to')}
                />
              </Field>
            </FieldGroup>
          </FieldSet>
          {Object.keys(form.formState.errors).length > 0 && (
            <p role='alert' className='text-destructive text-sm'>
              {t(
                'Check the currency pair, amount and date range (up to 366 days).'
              )}
            </p>
          )}
          <Button type='submit' disabled={busy}>
            {query.isPending ? t('Processing...') : t('Query reference rates')}
          </Button>
        </form>
        {query.isPending && (
          <div role='status'>
            <LoadingState inline message={t('Fetching reference rates...')} />
          </div>
        )}
        {query.isError && (
          <div role='alert'>
            <ErrorState
              className='min-h-32'
              title={t('Unable to query reference rates')}
              description={getServerErrorMessage(query.error)}
            />
          </div>
        )}
        {!query.data && !query.isPending && !query.isError && (
          <EmptyState
            className='min-h-28'
            title={t('Select a currency pair and date range')}
          />
        )}
        {query.data && (
          <FXReferenceResult
            result={query.data}
            onAnalyze={props.onAnalyze}
            disabled={props.disabled}
          />
        )}
      </CardContent>
    </Card>
  )
}
