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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { QuantBacktest } from '../quant-backtest'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('rejects invalid rows without calling the backtest API', async () => {
  const post = vi.spyOn(api, 'post')
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <QuantBacktest />
    </QueryClientProvider>
  )
  await user.type(screen.getByLabelText('Daily price data'), 'invalid')
  await user.click(screen.getByRole('button', { name: 'Run backtest' }))
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Unable to run the backtest; check the input data'
  )
  expect(post).not.toHaveBeenCalled()
})

test('sends daily prices in fen and displays the result', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        trades: [],
        equity: [{ date: '2026-01-05', equity_fen: 10000000 }],
      },
    },
  })
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <QuantBacktest />
    </QueryClientProvider>
  )
  await user.click(screen.getByText('Backtest settings'))
  await user.clear(screen.getByLabelText('Moving average window (days)'))
  await user.type(screen.getByLabelText('Moving average window (days)'), '5')
  await user.type(
    screen.getByLabelText('Daily price data'),
    '2026-01-05,1000,1010'
  )
  await user.click(screen.getByRole('button', { name: 'Run backtest' }))
  await screen.findByText(/Final equity \(fen\)/)
  expect(post).toHaveBeenCalledWith(
    '/api/quant/backtest',
    expect.objectContaining({
      bars: [{ date: '2026-01-05', open_fen: 1000, close_fen: 1010 }],
      config: expect.objectContaining({ window: 5 }),
    })
  )
})

test('imports a CSV with a column header into the editable daily data', async () => {
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <QuantBacktest />
    </QueryClientProvider>
  )
  const file = new File(
    ['date,open_fen,close_fen\n2026-01-05,1000,1010'],
    'bars.csv',
    { type: 'text/csv' }
  )
  Object.defineProperty(file, 'text', {
    value: async () => 'date,open_fen,close_fen\n2026-01-05,1000,1010',
  })
  await user.upload(screen.getByLabelText('Import CSV'), file)
  expect(
    await screen.findByDisplayValue('2026-01-05,1000,1010')
  ).toBeInTheDocument()
})
