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

import { MomentumScreen } from '../momentum-screen'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('screens local prices and displays ranked and excluded symbols', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        items: [{ symbol: '600000.SH', momentum_bps: 1000 }],
        excluded: ['000001.SZ'],
      },
    },
  })
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MomentumScreen />
    </QueryClientProvider>
  )
  await user.type(
    screen.getByLabelText('Screening price data'),
    '600000.SH,2026-01-05,1000\n600000.SH,2026-01-06,1100'
  )
  await user.type(screen.getByLabelText('As-of date'), '2026-01-06')
  await user.clear(screen.getByLabelText('Lookback (trading days)'))
  await user.type(screen.getByLabelText('Lookback (trading days)'), '1')
  await user.click(screen.getByRole('button', { name: 'Run screening' }))
  await screen.findByText(/600000.SH: 1,000/)
  expect(screen.getByText(/Excluded symbols.*000001.SZ/)).toBeInTheDocument()
  expect(post).toHaveBeenCalledWith(
    '/api/quant/screen',
    expect.objectContaining({ as_of: '2026-01-06', lookback: 1 })
  )
})

test('does not send malformed price data', async () => {
  const post = vi.spyOn(api, 'post')
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MomentumScreen />
    </QueryClientProvider>
  )
  await user.type(screen.getByLabelText('Screening price data'), 'bad,data')
  await user.type(screen.getByLabelText('As-of date'), '2026-01-06')
  await user.click(screen.getByRole('button', { name: 'Run screening' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Unable to screen the data; check the input'
  )
  expect(post).not.toHaveBeenCalled()
})
