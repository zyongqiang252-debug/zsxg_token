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

import { Dialog } from '@/components/dialog'

import type { ResearchSource, SavedDocument } from './research-workflow'

export function SourceDialog(props: {
  document: SavedDocument | null
  source?: ResearchSource
  onClose: () => void
}) {
  const { t } = useTranslation()
  const chars = [...(props.document?.text ?? '')]
  return (
    <Dialog
      open={!!props.document}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={props.document?.name ?? t('View original')}
    >
      <pre className='max-h-[60vh] overflow-y-auto text-sm break-words whitespace-pre-wrap'>
        {props.source ? (
          <>
            {chars.slice(0, props.source.start).join('')}
            <mark
              ref={(element) => {
                element?.scrollIntoView?.({ block: 'center' })
              }}
            >
              {chars.slice(props.source.start, props.source.end).join('')}
            </mark>
            {chars.slice(props.source.end).join('')}
          </>
        ) : (
          props.document?.text
        )}
      </pre>
    </Dialog>
  )
}
