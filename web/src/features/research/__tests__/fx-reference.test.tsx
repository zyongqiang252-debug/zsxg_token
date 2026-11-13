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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { FXReference } from '../fx-reference'
import { ResearchAssistant } from '../index'
import type { FXResult } from '../lib/fx-reference'

const result: FXResult = {
  base: 'USD',
  quote: 'CNY',
  amount: '0.1',
  from: '2024-01-01',
  to: '2024-01-07',
  rate: '7.2',
  rate_date: '2024-01-05',
  converted_amount: '0.72',
  first_date: '2024-01-02',
  change_percent: '1.408451',
  min_rate: '7.1',
  max_rate: '7.2',
  observation_count: 2,
  observations: [
    { date: '2024-01-02', rate: '7.1' },
    { date: '2024-01-05', rate: '7.2' },
  ],
  provider: 'ECB via Frankfurter',
  source_url: 'https://www.ecb.europa.eu/',
  api_url: 'https://api.frankfurter.dev/',
  retrieved_at: '2024-01-08T12:00:00Z',
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAuthStore.getState().auth.reset()
})

function queryForm() {
  fireEvent.change(screen.getByLabelText('From date'), {
    target: { value: result.from },
  })
  fireEvent.change(screen.getByLabelText('To date'), {
    target: { value: result.to },
  })
  fireEvent.change(screen.getByLabelText('Amount in base currency'), {
    target: { value: result.amount },
  })
}

function renderTool() {
  const onAnalyze = vi.fn()
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <FXReference onAnalyze={onAnalyze} />
    </QueryClientProvider>
  )
  queryForm()
  return onAnalyze
}

test('query displays exact conversion, direction, observation dates and provenance, then clears the old result when inputs change', async () => {
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true, data: result } })
  const onAnalyze = renderTool()
  const user = userEvent.setup()
  await user.click(
    screen.getByRole('button', { name: 'Query reference rates' })
  )
  expect(await screen.findByText('0.1 USD = 0.72 CNY')).toBeVisible()
  expect(screen.getByText('1 USD = 7.2 CNY')).toBeVisible()
  expect(screen.getByText('1.408451%')).toBeVisible()
  expect(screen.getByText(/2024-01-08T12:00:00Z/)).toBeVisible()
  expect(post).toHaveBeenCalledWith(
    '/api/fx/reference',
    expect.objectContaining({ base: 'USD', quote: 'CNY', amount: '0.1' })
  )
  await user.click(
    screen.getByRole('button', { name: 'Attach result to assistant' })
  )
  const attached = JSON.parse(onAnalyze.mock.calls[0][0])
  expect(attached).toMatchObject({
    kind: 'fx_reference',
    rate_date: result.rate_date,
    converted_amount: '0.72',
    first_rate: '7.1',
    provider: result.provider,
  })
  expect(attached.observations).toBeUndefined()
  await user.selectOptions(screen.getByLabelText('Quote currency'), 'JPY')
  expect(
    screen.queryByRole('region', { name: 'FX reference result' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Attach result to assistant' })
  ).not.toBeInTheDocument()
})

test('invalid pair or exponent amount cannot query the provider', async () => {
  const post = vi.spyOn(api, 'post')
  renderTool()
  const user = userEvent.setup()
  await user.selectOptions(screen.getByLabelText('Quote currency'), 'USD')
  await user.click(
    screen.getByRole('button', { name: 'Query reference rates' })
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Check the currency pair'
  )
  await user.selectOptions(screen.getByLabelText('Quote currency'), 'CNY')
  fireEvent.change(screen.getByLabelText('Amount in base currency'), {
    target: { value: '1e99999999' },
  })
  await user.click(
    screen.getByRole('button', { name: 'Query reference rates' })
  )
  expect(screen.getByLabelText('Amount in base currency')).toHaveAttribute(
    'aria-invalid',
    'true'
  )
  expect(post).not.toHaveBeenCalled()
})

test('in-flight query disables edits and attachment until data arrives', async () => {
  let complete!: (value: unknown) => void
  vi.spyOn(api, 'post').mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }) as ReturnType<typeof api.post>
  )
  renderTool()
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Query reference rates' }))
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Fetching reference rates'
  )
  expect(screen.getByLabelText('Base currency')).toBeDisabled()
  expect(
    screen.queryByRole('button', { name: 'Attach result to assistant' })
  ).not.toBeInTheDocument()
  complete({ data: { success: true, data: result } })
  await screen.findByText('0.1 USD = 0.72 CNY')
  expect(screen.getByLabelText('Base currency')).toBeEnabled()
})

test('provider no-data error is shown and does not expose a stale attachment', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: false,
      message: 'No reference rates in this period. Try a wider date range.',
    },
  })
  renderTool()
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Query reference rates' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'No reference rates in this period'
  )
  expect(
    screen.queryByRole('button', { name: 'Attach result to assistant' })
  ).not.toBeInTheDocument()
})

test('attaching FX results focuses the assistant question and sends provenance with selected user documents', async () => {
  const user = userEvent.setup()
  useAuthStore.getState().auth.setUser({ id: 1, username: 'test', role: 1 })
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: [{ id: 7, name: 'notes.txt', text: 'my FX observations' }],
    },
  })
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: result },
  })
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Explanation' } }] }),
        { status: 200 }
      )
    )
  vi.stubGlobal('fetch', fetch)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ResearchAssistant />
    </QueryClientProvider>
  )
  await screen.findByText('notes.txt')
  await user.click(screen.getByRole('button', { name: 'notes.txt' }))
  queryForm()
  await user.click(
    screen.getByRole('button', { name: 'Query reference rates' })
  )
  await user.click(
    await screen.findByRole('button', { name: 'Attach result to assistant' })
  )
  expect(screen.getByLabelText('Question')).toHaveFocus()
  await user.type(screen.getByLabelText('API token'), 'test-token')
  await user.click(screen.getByRole('button', { name: 'Ask assistant' }))
  await waitFor(() => expect(fetch).toHaveBeenCalled())
  const payload = JSON.parse(fetch.mock.calls[0][1].body)
  expect(payload.documents).toEqual([
    { id: '7', name: 'notes.txt', text: 'my FX observations' },
  ])
  expect(JSON.parse(payload.context)).toMatchObject({
    kind: 'fx_reference',
    provider: result.provider,
    rate_date: result.rate_date,
  })
})
