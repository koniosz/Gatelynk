'use client'
/**
 * RestartButton — wysyła POST /edge/restart, state-machine z toast-like feedback.
 *
 * State: idle | loading | ok | err. Każdy stan zmienia ikonę + label + tła.
 * Po `ok` / `err` wraca do `idle` po 3s.
 */
import { useState } from 'react'
import { RotateCw, Check, X } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from './Spinner'
import type { ActionState } from '../types'

interface Props {
  buildingId: string
  deviceId: string
  size?: 'sm' | 'md'
}

export function RestartButton({ buildingId, deviceId, size = 'md' }: Props) {
  const [state, setState] = useState<ActionState>('idle')

  const handleClick = async () => {
    setState('loading')
    try {
      await integratorApi.post(`/integrator/buildings/${buildingId}/edge/restart`, { deviceId })
      setState('ok')
      setTimeout(() => setState('idle'), 3000)
    } catch {
      setState('err')
      setTimeout(() => setState('idle'), 3000)
    }
  }

  const palette =
    state === 'ok'  ? 'bg-success-50 border-success text-success'
    : state === 'err' ? 'bg-danger-50 border-danger text-danger'
    : 'bg-warn-50 border-warn text-warn hover:bg-warn-50'

  const padding = size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-[12px]'

  return (
    <button
      onClick={handleClick}
      disabled={state === 'loading'}
      title="Zrestartuj urządzenie"
      className={`inline-flex items-center gap-1.5 rounded-r2 border font-medium transition-colors ${padding} ${palette}`}
    >
      {state === 'loading' ? <Spinner size={12} />
        : state === 'ok' ? <Check size={12} />
        : state === 'err' ? <X size={12} />
        : <RotateCw size={12} />}
      {state === 'ok' ? 'Restart…' : state === 'err' ? 'Błąd' : 'Restart'}
    </button>
  )
}
