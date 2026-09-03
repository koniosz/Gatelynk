'use client'
/**
 * RelayPanel — przyciski wyzwalające przekaźniki domofonu / kontrolera.
 *
 * Per-relay state machine + toast feedback ('Otwarto!', 'Błąd'). Backend
 * endpoint: POST /integrator/buildings/:id/edge/relay z deviceId + relayIndex.
 */
import { useState } from 'react'
import { Unlock, Check, X } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from './Spinner'
import type { ActionState } from '../types'

interface Props {
  buildingId: string
  deviceId: string
  relays: { index: number; name: string }[]
}

export function RelayPanel({ buildingId, deviceId, relays }: Props) {
  const [states, setStates] = useState<Record<number, ActionState>>({})

  const trigger = async (relayIndex: number) => {
    setStates((s) => ({ ...s, [relayIndex]: 'loading' }))
    try {
      await integratorApi.post(`/integrator/buildings/${buildingId}/edge/relay`, {
        deviceId, relayIndex,
      })
      setStates((s) => ({ ...s, [relayIndex]: 'ok' }))
      setTimeout(() => setStates((s) => ({ ...s, [relayIndex]: 'idle' })), 2500)
    } catch {
      setStates((s) => ({ ...s, [relayIndex]: 'err' }))
      setTimeout(() => setStates((s) => ({ ...s, [relayIndex]: 'idle' })), 2500)
    }
  }

  if (!relays.length) {
    return <p className="text-[12px] text-muted py-2">Brak skonfigurowanych przekaźników</p>
  }

  return (
    <div className="flex flex-wrap gap-2">
      {relays.map((r) => {
        const st: ActionState = states[r.index] ?? 'idle'
        const palette =
          st === 'ok'  ? 'bg-success-50 border-success text-success'
          : st === 'err' ? 'bg-danger-50 border-danger text-danger'
          : 'bg-warn-50 border-warn text-warn hover:bg-warn-50/80'
        return (
          <button
            key={r.index}
            onClick={() => trigger(r.index)}
            disabled={st === 'loading'}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-r2 text-[13px] font-medium border transition-colors ${palette}`}
          >
            {st === 'loading' ? <Spinner size={14} />
              : st === 'ok' ? <Check size={14} />
              : st === 'err' ? <X size={14} />
              : <Unlock size={14} />}
            {st === 'ok' ? 'Otwarto!' : st === 'err' ? 'Błąd' : r.name}
          </button>
        )
      })}
    </div>
  )
}
