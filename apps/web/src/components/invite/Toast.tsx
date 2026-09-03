'use client'
import { useEffect } from 'react'
import { IconCheck, IconWarning } from './icons'

interface Props {
  msg: string | null
  tone: 'ok' | 'fail'
  onHide: () => void
}

/**
 * Toast wg handoffu: dark glass pill (bottom 28px), zielony check / czerwony
 * warning w `gli-tc`. Auto-dismiss po 2 s (timing z Guest Invite.html).
 */
export function Toast({ msg, tone, onHide }: Props) {
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(onHide, 2000)
    return () => clearTimeout(t)
  }, [msg, onHide])

  const cls = ['gli-toast', tone === 'fail' ? 'gli-fail' : '', msg ? 'gli-show' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls}>
      <span className="gli-tc">{tone === 'fail' ? <IconWarning size={14} /> : <IconCheck />}</span>
      <span>{msg ?? ''}</span>
    </div>
  )
}
