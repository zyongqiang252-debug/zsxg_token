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
import { ListFilter } from 'lucide-react'
import { useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { toIntlLocale } from '@/i18n/languages'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'

type Screening = {
  items: { symbol: string; momentum_bps: number }[]
  excluded: string[]
}

export function MomentumScreen(props: {
  onAnalyze?: (context: string) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [csv, setCsv] = useState('')
  const [date, setDate] = useState('')
  const [lookback, setLookback] = useState(20)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Screening | null>(null)
  const [reading, setReading] = useState(false)
  async function importCSV(file: File) {
    setError('')
    setResult(null)
    if (file.size > 2 * 1024 * 1024) {
      setError(t('Unable to read the CSV file'))
      return
    }
    setReading(true)
    try {
      setCsv(
        (await file.text())
          .replace(/^\uFEFF/, '')
          .replace(/^symbol\s*,\s*date\s*,\s*close_fen\s*\r?\n/i, '')
      )
    } catch {
      setError(t('Unable to read the CSV file'))
    } finally {
      setReading(false)
    }
  }
  const screen = useMutation({
    meta: { errorToast: false },
    mutationFn: async () => {
      const rows = csv.trim().split(/\r?\n/)
      if (!csv.trim() || rows.length > 50000 || !date) {
        throw new Error('Invalid input')
      }
      const series = new Map<string, { date: string; close_fen: number }[]>()
      for (const row of rows) {
        const values = row.split(',').map((value) => value.trim())
        if (values.length !== 3 || !values[0] || !/^\d+$/.test(values[2])) {
          throw new Error('Invalid row')
        }
        const bars = series.get(values[0]) ?? []
        bars.push({ date: values[1], close_fen: Number(values[2]) })
        series.set(values[0], bars)
      }
      const response = await api.post<{ success: boolean; data?: Screening }>(
        '/api/quant/screen',
        {
          as_of: date,
          lookback,
          instruments: Array.from(series, ([symbol, bars]) => ({
            symbol,
            bars,
          })),
        }
      )
      const data = requireServerSuccess(response.data)
      if (!data.data) throw new Error('Missing result')
      return data.data
    },
    onMutate: () => {
      setError('')
      setResult(null)
    },
    onSuccess: setResult,
    onError: () => setError(t('Unable to screen the data; check the input')),
  })
  return (
    <Card className='gap-0 rounded-2xl border-0 py-0 shadow-sm'>
      <CardHeader className='border-b px-6 py-5 sm:px-7'>
        <CardTitle className='flex items-center gap-3 text-lg font-semibold'>
          <span className='flex size-10 items-center justify-center rounded-xl bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300'>
            <ListFilter className='size-5' />
          </span>
          {t('Local momentum screening')}
        </CardTitle>
        <CardDescription>
          {t(
            'Import symbol, date and close price in fen; each symbol must be ordered by date.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-5 p-6 sm:p-7'>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Research statistics only; missing or stale series are excluded, and results are not investment recommendations.'
          )}
        </p>
        <div className='space-y-2'>
          <Label htmlFor='screen-file'>{t('Import CSV')}</Label>
          <Input
            id='screen-file'
            type='file'
            accept='.csv,text/csv'
            disabled={reading || screen.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void importCSV(file)
            }}
          />
        </div>
        <div className='space-y-2'>
          <Label htmlFor='screen-data'>{t('Screening price data')}</Label>
          <Textarea
            id='screen-data'
            className='min-h-28 font-mono text-sm'
            value={csv}
            disabled={reading || screen.isPending}
            onChange={(event) => {
              setResult(null)
              setCsv(event.target.value)
            }}
            placeholder='600000.SH,2026-01-05,1000'
          />
        </div>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label htmlFor='screen-date'>{t('As-of date')}</Label>
            <Input
              id='screen-date'
              type='date'
              value={date}
              disabled={reading || screen.isPending}
              onChange={(event) => {
                setResult(null)
                setDate(event.target.value)
              }}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='screen-lookback'>
              {t('Lookback (trading days)')}
            </Label>
            <Input
              id='screen-lookback'
              type='number'
              min={1}
              max={250}
              step={1}
              value={lookback}
              disabled={reading || screen.isPending}
              onChange={(event) => {
                setResult(null)
                setLookback(Number(event.target.value))
              }}
            />
          </div>
        </div>
        {error && (
          <p role='alert' className='text-destructive text-sm'>
            {error}
          </p>
        )}
        <Button
          disabled={reading || screen.isPending}
          onClick={() => screen.mutate()}
        >
          {screen.isPending ? t('Processing...') : t('Run screening')}
        </Button>
        {result && (
          <div
            aria-live='polite'
            className='bg-muted/40 space-y-3 rounded-xl border p-4 text-sm'
          >
            <p>{t('Momentum (basis points)')}</p>
            <ul>
              {result.items.map((item) => (
                <li key={item.symbol}>
                  {item.symbol}: {formatNumber(item.momentum_bps, locale)}
                </li>
              ))}
            </ul>
            <p>
              {t('Excluded symbols')}: {result.excluded.join(', ') || '—'}
            </p>
            {props.onAnalyze && (
              <Button
                type='button'
                variant='outline'
                onClick={() =>
                  props.onAnalyze?.(
                    JSON.stringify({
                      kind: 'momentum_screen',
                      as_of: date,
                      lookback,
                      ...result,
                      limitations:
                        'Local input data only; not an investment recommendation.',
                    })
                  )
                }
              >
                {t('Attach result to assistant')}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
