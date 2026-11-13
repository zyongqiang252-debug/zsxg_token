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
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { StaticDataTable } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip } from '@/components/ui/chart'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import { fxAssistantContext, type FXResult } from './lib/fx-reference'

export function FXReferenceResult(props: {
  result: FXResult
  onAnalyze?: (context: string) => void
  disabled?: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const result = props.result
  // Display server decimal strings verbatim. Billing currency formatters change
  // units, and ordinary number formatters would lose small FX rates/precision.
  return (
    <section
      aria-label={t('FX reference result')}
      aria-live='polite'
      className='space-y-4 rounded-xl border p-4'
    >
      <div className='grid gap-4 sm:grid-cols-2'>
        <div>
          <p className='text-muted-foreground text-sm'>
            {t('Last published rate in period')}
          </p>
          <p className='text-xl font-semibold break-words tabular-nums'>
            1 {result.base} = {result.rate} {result.quote}
          </p>
          <p className='text-muted-foreground text-xs'>
            {t('Rate date')}: {result.rate_date}
          </p>
        </div>
        <div>
          <p className='text-muted-foreground text-sm'>
            {t('Conversion at last published rate')}
          </p>
          <p className='font-medium break-words tabular-nums'>
            {result.amount} {result.base} = {result.converted_amount}{' '}
            {result.quote}
          </p>
        </div>
      </div>
      <dl className='grid gap-3 text-sm sm:grid-cols-3'>
        <div>
          <dt>{t('First-to-last published change')}</dt>
          <dd className='font-medium tabular-nums'>{result.change_percent}%</dd>
        </div>
        <div>
          <dt>{t('Period low / high')}</dt>
          <dd className='font-medium tabular-nums'>
            {result.min_rate} / {result.max_rate}
          </dd>
        </div>
        <div>
          <dt>{t('Published observations')}</dt>
          <dd>
            {formatNumber(result.observation_count, locale)} (
            {result.first_date} → {result.rate_date})
          </dd>
        </div>
      </dl>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Change compares the first and last published days in the selected period. Missing days are not filled; one observation gives 0% change.'
        )}
      </p>
      <ChartContainer
        className='h-52 w-full'
        config={{
          rate: { label: t('Reference rate'), color: 'var(--primary)' },
        }}
        aria-label={t('Reference rate history')}
      >
        <LineChart accessibilityLayer data={result.observations}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey='date' minTickGap={36} />
          <YAxis type='number' domain={['auto', 'auto']} width={75} />
          <ChartTooltip />
          <Line
            type='linear'
            dataKey='rate'
            name={t('Reference rate')}
            stroke='var(--color-rate)'
            strokeWidth={2}
            dot={result.observation_count === 1}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
      <details>
        <summary className='cursor-pointer text-sm font-medium'>
          {t('View published observations')}
        </summary>
        <StaticDataTable
          className='mt-3 max-h-64 overflow-auto'
          data={result.observations}
          getRowKey={(row) => row.date}
          tableProps={{ 'aria-label': t('Reference rate history') }}
          columns={[
            { id: 'date', header: t('Rate date'), cell: (row) => row.date },
            {
              id: 'rate',
              header: `${result.base} / ${result.quote}`,
              cell: (row) => row.rate,
            },
          ]}
        />
      </details>
      <p className='text-muted-foreground text-xs break-words'>
        {t('Data source')}:{' '}
        <a
          href='https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html'
          target='_blank'
          rel='noreferrer'
          className='underline'
        >
          ECB
        </a>
        {' / '}
        <a
          href='https://frankfurter.dev/'
          target='_blank'
          rel='noreferrer'
          className='underline'
        >
          Frankfurter
        </a>
        {' · '}
        {t('Retrieved at (UTC)')}: {result.retrieved_at}
      </p>
      {props.onAnalyze && (
        <Button
          type='button'
          variant='outline'
          disabled={props.disabled}
          onClick={() => props.onAnalyze?.(fxAssistantContext(result))}
        >
          {t('Attach result to assistant')}
        </Button>
      )}
    </section>
  )
}
