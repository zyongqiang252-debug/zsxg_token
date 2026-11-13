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
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { ReportEditor } from '../research-report-editor'
import { readReport, type ResearchReport } from '../research-workflow'

const report: ResearchReport = {
  kind: 'summary',
  body: 'source summary [S1]',
  sources: [{ id: 'S1', documentId: 7, name: 'notes.txt', start: 0, end: 10 }],
}
beforeEach(() =>
  useAuthStore.getState().auth.setUser({ id: 1, username: 'test', role: 1 })
)
afterEach(() => {
  vi.restoreAllMocks()
  useAuthStore.getState().auth.reset()
})

test('oversized encoded reports are blocked before the API call and can be saved after shortening', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: { id: 9, name: 'result', text: 'stored' } },
  })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReportEditor
        report={report}
        title='result'
        ownerId={1}
        documents={[]}
        disabled={false}
      />
    </QueryClientProvider>
  )
  fireEvent.change(screen.getByLabelText('Edit research result'), {
    target: { value: '"'.repeat(55000) },
  })
  expect(screen.getByRole('alert')).toHaveTextContent(
    'exceed the storage limit'
  )
  expect(
    screen.getByRole('button', { name: 'Save as new document' })
  ).toBeDisabled()
  expect(post).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Edit research result'), {
    target: { value: 'Shortened draft [S1]' },
  })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Save as new document' }))
  await screen.findByText('Research result saved')
  const payload = post.mock.calls[0][1] as { text: string }
  expect(readReport(payload.text)).toMatchObject({
    body: 'Shortened draft [S1]',
    sources: report.sources,
  })
})

test('two report editors keep independent title and body labels and keyboard focus', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReportEditor
        report={report}
        title='first'
        ownerId={1}
        documents={[]}
        disabled={false}
      />
      <ReportEditor
        report={report}
        title='second'
        ownerId={1}
        documents={[]}
        disabled={false}
      />
    </QueryClientProvider>
  )
  const first = within(
    screen.getByRole('form', { name: 'Research result editor: first' })
  )
  const second = within(
    screen.getByRole('form', { name: 'Research result editor: second' })
  )
  const user = userEvent.setup()
  await user.click(second.getByText('Result title'))
  expect(second.getByLabelText('Result title')).toHaveFocus()
  await user.type(second.getByLabelText('Result title'), ' changed')
  expect(first.getByLabelText('Result title')).toHaveValue('first')
  await user.click(second.getByText('Edit research result'))
  expect(second.getByLabelText('Edit research result')).toHaveFocus()
  expect(first.getByLabelText('Edit research result').id).not.toBe(
    second.getByLabelText('Edit research result').id
  )
})
