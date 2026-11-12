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

type Result = {
  trades: {
    date: string
    side: string
    shares: number
    price_fen: number
    fee_fen: number
  }[]
  equity: { date: string; equity_fen: number }[]
}

export function QuantBacktest(props: {
  onAnalyze?: (context: string) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [csv, setCsv] = useState('')
  const [config, setConfig] = useState({
    initial_cash_fen: 10000000,
    window: 20,
    commission_bps: 3,
    minimum_fee_fen: 500,
    sell_tax_bps: 5,
    slippage_bps: 0,
  })
  const fields = [
    {
      key: 'initial_cash_fen',
      label: 'Initial cash (fen)',
      min: 1,
      max: 1000000000000,
    },
    { key: 'window', label: 'Moving average window (days)', min: 2, max: 250 },
    {
      key: 'commission_bps',
      label: 'Commission (basis points)',
      min: 0,
      max: 1000,
    },
    {
      key: 'minimum_fee_fen',
      label: 'Minimum commission (fen)',
      min: 0,
      max: 1000000,
    },
    {
      key: 'sell_tax_bps',
      label: 'Sell tax (basis points)',
      min: 0,
      max: 1000,
    },
    {
      key: 'slippage_bps',
      label: 'Slippage (basis points)',
      min: 0,
      max: 1000,
    },
  ] as const
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function importCSV(file: File) {
    setError('')
    setResult(null)
    if (file.size > 2 * 1024 * 1024) {
      setError(t('Unable to read the CSV file'))
      return
    }
    setPending(true)
    try {
      const text = await file.text()
      setCsv(
        text
          .replace(/^\uFEFF/, '')
          .replace(/^date\s*,\s*open_fen\s*,\s*close_fen\s*\r?\n/i, '')
      )
    } catch {
      setError(t('Unable to read the CSV file'))
    } finally {
      setPending(false)
    }
  }

  const backtest = useMutation({
    meta: { errorToast: false },
    mutationFn: async () => {
      const lines = csv.trim().split(/\r?\n/)
      if (!csv.trim() || lines.length > 5000) throw new Error('Invalid rows')
      const bars = lines.map((line) => {
        const values = line.split(',').map((value) => value.trim())
        if (
          values.length !== 3 ||
          !/^\d+$/.test(values[1]) ||
          !/^\d+$/.test(values[2])
        ) {
          throw new Error('Invalid row')
        }
        return {
          date: values[0],
          open_fen: Number(values[1]),
          close_fen: Number(values[2]),
        }
      })
      const response = await api.post<{ success: boolean; data?: Result }>(
        '/api/quant/backtest',
        {
          bars,
          config,
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
    onError: () =>
      setError(t('Unable to run the backtest; check the input data')),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('A-share backtest preview')}</CardTitle>
        <CardDescription>
          {t(
            'Paste daily data as date, open price in fen, close price in fen; one row per trading day, oldest first.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Research approximation only: price limits, suspensions, liquidity, corporate actions and partial fills are not simulated.'
          )}
        </p>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Default assumptions: 100,000 yuan starting cash, 20-day moving average, 0.03% commission (minimum 5 yuan), 0.05% sell tax, no slippage.'
          )}
        </p>
        <details className='space-y-3'>
          <summary className='cursor-pointer text-sm font-medium'>
            {t('Backtest settings')}
          </summary>
          <div className='grid gap-3 sm:grid-cols-2'>
            {fields.map((field) => (
              <div key={field.key} className='space-y-2'>
                <Label htmlFor={`quant-${field.key}`}>{t(field.label)}</Label>
                <Input
                  id={`quant-${field.key}`}
                  type='number'
                  min={field.min}
                  max={field.max}
                  step={1}
                  disabled={pending || backtest.isPending}
                  value={config[field.key]}
                  onChange={(event) => {
                    setResult(null)
                    setConfig((old) => ({
                      ...old,
                      [field.key]: Number(event.target.value),
                    }))
                  }}
                />
              </div>
            ))}
          </div>
        </details>
        <div className='space-y-2'>
          <Label htmlFor='quant-file'>{t('Import CSV')}</Label>
          <Input
            id='quant-file'
            type='file'
            accept='.csv,text/csv'
            disabled={pending || backtest.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void importCSV(file)
            }}
          />
        </div>
        <div className='space-y-2'>
          <Label htmlFor='quant-data'>{t('Daily price data')}</Label>
          <Textarea
            id='quant-data'
            value={csv}
            disabled={pending || backtest.isPending}
            onChange={(event) => {
              setResult(null)
              setCsv(event.target.value)
            }}
            placeholder='2026-01-05,1000,1010'
          />
        </div>
        {error && (
          <p role='alert' className='text-destructive text-sm'>
            {error}
          </p>
        )}
        <Button
          disabled={pending || backtest.isPending}
          onClick={() => backtest.mutate()}
        >
          {pending || backtest.isPending
            ? t('Processing...')
            : t('Run backtest')}
        </Button>
        {result && (
          <div aria-live='polite' className='space-y-2 text-sm'>
            <p>
              {t('Final equity (fen)')}:{' '}
              {formatNumber(result.equity.at(-1)?.equity_fen, locale)}
            </p>
            <p>
              {t('Trades')}: {formatNumber(result.trades.length, locale)}
            </p>
            <pre className='overflow-auto whitespace-pre-wrap'>
              {result.trades
                .map(
                  (trade) =>
                    `${trade.date} ${trade.side === 'buy' ? t('Buy') : t('Sell')} ${formatNumber(trade.shares, locale)} × ${formatNumber(trade.price_fen, locale)} (${t('Fee (fen)')}: ${formatNumber(trade.fee_fen, locale)})`
                )
                .join('\n')}
            </pre>
            {props.onAnalyze && (
              <Button
                type='button'
                variant='outline'
                onClick={() =>
                  props.onAnalyze?.(
                    JSON.stringify({
                      kind: 'backtest',
                      config,
                      from: result.equity[0]?.date,
                      to: result.equity.at(-1)?.date,
                      final_equity_fen: result.equity.at(-1)?.equity_fen,
                      trade_count: result.trades.length,
                      trades: result.trades.slice(0, 30),
                      limitations:
                        'No price limits, suspensions, liquidity, corporate actions or partial fills.',
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
