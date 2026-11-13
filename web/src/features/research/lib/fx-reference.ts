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
import { z } from 'zod'

export const fxCurrencies =
  'USD CNY EUR JPY GBP HKD SGD AUD CAD CHF NZD KRW INR THB MYR IDR PHP SEK NOK DKK'.split(
    ' '
  )

export const fxSchema = z
  .object({
    base: z.string().refine((value) => fxCurrencies.includes(value)),
    quote: z.string().refine((value) => fxCurrencies.includes(value)),
    amount: z
      .string()
      .trim()
      .regex(/^\d{1,13}(\.\d{1,8})?$/)
      .refine((value) => Number(value) <= 1e12),
    from: z.iso.date().min(10),
    to: z.iso.date().min(10),
  })
  .refine(
    (value) =>
      value.base !== value.quote &&
      value.from >= '1999-01-04' &&
      value.from <= value.to &&
      Date.parse(value.to) - Date.parse(value.from) <= 365 * 86400000
  )

export type FXInput = z.infer<typeof fxSchema>
export type FXResult = FXInput & {
  rate: string
  rate_date: string
  converted_amount: string
  first_date: string
  change_percent: string
  min_rate: string
  max_rate: string
  observation_count: number
  observations: { date: string; rate: string }[]
  provider: string
  source_url: string
  api_url: string
  retrieved_at: string
}

export function fxAssistantContext(result: FXResult): string {
  // Keep exact decimal strings and provenance; the full time series stays local.
  const { observations, ...summary } = result
  return JSON.stringify({
    kind: 'fx_reference',
    ...summary,
    first_rate: observations[0]?.rate,
    limitations:
      'ECB reference data via Frankfurter, not executable quotes. Conversion = amount * last observed rate; change = (last / first - 1) * 100, rounded to 6 decimal places. Actual publication days only, no interpolation. Historical changes are not forecasts. Summary only; full observations are not attached. Explain alongside the selected user documents and distinguish evidence from inference.',
  })
}
