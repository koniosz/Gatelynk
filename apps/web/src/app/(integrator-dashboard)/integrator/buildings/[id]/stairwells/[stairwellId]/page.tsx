'use client'
/**
 * Integrator → konfiguracja domofonu klatki.
 *
 * UI tej strony rezygnuje z hardcoded pól Akuvoxa (model, IP, login, hasło,
 * relays) na rzecz uniwersalnego `DeviceConfigForm`, który czyta katalog
 * `@gatelynk/device-drivers` i dynamicznie renderuje pola pod wybranego
 * producenta i model. To pozwala wprowadzać dowolne parametry (RTSP, kanały,
 * porty, tryby LPR, …) bez przepisywania UI dla każdego nowego producenta.
 *
 * Format zapisu do API:
 *   PUT /integrator/buildings/{id}/stairwells/{swId}/intercom
 *   body: { driverId, config: { ipAddress, login, password, ..., relays } }
 *
 * API zapisuje:
 *   • cały blob do `stairwell_intercoms.config` (JSONB) + `driverId`,
 *   • mirror „kanonicznych" pól (ipAddress/login/password/relays/manufacturer/
 *     model) do dedykowanych kolumn — żeby istniejące Edge sync i widoki
 *     czytające bezpośrednio z `intercom.ipAddress` nadal działały.
 */
import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { integratorApi } from '@/lib/integrator-api'
import {
  DeviceConfigForm,
  type DeviceConfigValue,
} from '@/components/DeviceConfigForm'
import { findDriver, guessDriverId } from '@gatelynk/device-drivers'

export default function IntegratorStairwellPage() {
  const { id: buildingId, stairwellId } = useParams<{ id: string; stairwellId: string }>()
  const router = useRouter()
  const [stairwell, setStairwell] = useState<any>(null)
  const [buildingName, setBuildingName] = useState('')
  const [value, setValue] = useState<DeviceConfigValue>({ driverId: null, config: {} })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [swRes, bRes] = await Promise.all([
        integratorApi.get(`/integrator/buildings/${buildingId}/stairwells/${stairwellId}`),
        integratorApi.get(`/integrator/buildings/${buildingId}`),
      ])
      setStairwell(swRes.data)
      setBuildingName(bRes.data.name)

      const ic = swRes.data.intercom
      if (ic) {
        // Preferuj nowy format (driverId + config). Jeśli go nie ma — zbuduj
        // z legacy kolumn i zgadnij driver po manufacturer/model.
        if (ic.driverId) {
          setValue({ driverId: ic.driverId, config: ic.config ?? {} })
        } else {
          const guessed = guessDriverId('INTERCOM', {
            manufacturer: ic.manufacturer,
            model: ic.model,
          })
          const config: Record<string, unknown> = {
            ipAddress: ic.ipAddress ?? '',
            login: ic.login ?? '',
            password: ic.password ?? '',
            ...(ic.model ? { model: ic.model } : {}),
            ...(Array.isArray(ic.relays)
              ? { relays: ic.relays.map((r: any, i: number) => ({
                  index: typeof r.index === 'number' ? r.index : i + 1,
                  name: r.name ?? r.label ?? '',
                })) }
              : {}),
          }
          setValue({ driverId: guessed, config })
        }
      }
    } catch {
      router.push('/integrator/login')
    }
  }, [buildingId, stairwellId, router])

  useEffect(() => { load() }, [load])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setSaveError(null); setSaved(false)
    try {
      const driver = findDriver(value.driverId)
      // Wyciągnięte dla legacy klientów / Edge sync — żeby Cloud DB miało
      // mirror w dedykowanych kolumnach, a relays w spodziewanym formacie
      // {id, label} (gdzie zapisane jako `name`).
      const cfg = value.config
      const relaysArr = Array.isArray(cfg.relays)
        ? (cfg.relays as Array<{ index?: number; name?: string }>).map((r) => ({
            id: String(r.index ?? ''),
            label: r.name ?? '',
          })).filter((r) => r.label.trim())
        : undefined

      await integratorApi.put(
        `/integrator/buildings/${buildingId}/stairwells/${stairwellId}/intercom`,
        {
          // Nowy format
          driverId: value.driverId,
          config: cfg,
          // Legacy mirror (dla starszego API i Edge sync)
          manufacturer: driver?.manufacturer,
          model: typeof cfg.model === 'string' ? cfg.model : null,
          ipAddress: typeof cfg.ipAddress === 'string' ? cfg.ipAddress : null,
          login: typeof cfg.login === 'string' ? cfg.login : null,
          password: typeof cfg.password === 'string' ? cfg.password : null,
          ...(relaysArr ? { relays: relaysArr } : {}),
        }
      )
      setSaved(true)
      load()
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setSaveError(err?.response?.data?.message ?? 'Błąd zapisu')
    } finally { setSaving(false) }
  }

  if (!stairwell) return <p className="text-gray-400">Ładowanie...</p>

  return (
    <div className="max-w-2xl">
      {/* Header */}
      <div className="mb-6">
        <Link href={`/integrator/buildings/${buildingId}`} className="text-sm text-gray-400 hover:text-gray-600">
          ← {buildingName || 'Budynek'}
        </Link>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-2xl">🏛️</span>
          <h1 className="text-2xl font-bold text-gray-900">{stairwell.name}</h1>
        </div>
        <p className="text-sm text-gray-400">Konfiguracja domofonu</p>
      </div>

      <form onSubmit={handleSave} className="space-y-5">
        {saveError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{saveError}</div>
        )}
        {saved && (
          <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3">
            ✅ Konfiguracja zapisana pomyślnie
          </div>
        )}

        <DeviceConfigForm type="INTERCOM" value={value} onChange={setValue} />

        <button type="submit" disabled={saving || !value.driverId}
          className="w-full bg-blue-600 text-white text-sm font-semibold py-3 rounded-xl hover:bg-blue-700 disabled:opacity-50 transition">
          {saving ? 'Zapisywanie...' : '💾 Zapisz konfigurację domofonu'}
        </button>
      </form>
    </div>
  )
}
