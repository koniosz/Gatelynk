/**
 * Hook do listy urządzeń + statusów online.
 *
 * Polling co 15 s — Edge nie ma WebSocket-a dla device-status (jak `/logs/stream`),
 * więc REST poll wystarcza. Status każdego urządzenia (online/offline) wynika
 * z `/devices/tree` które wewnętrznie cache-uje 30s ping (`DeviceRegistry.pingCache`).
 */
import { useEffect, useState, useCallback } from 'react'
import { api } from './api'
import type { DeviceEntry, DeviceTreeGroup, DeviceTreeNode } from './types'

interface DevicesState {
  devices: DeviceEntry[]
  statusByDeviceId: Map<string, DeviceTreeNode>
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useDevices(): DevicesState {
  const [devices, setDevices] = useState<DeviceEntry[]>([])
  const [statusByDeviceId, setStatusByDeviceId] = useState<Map<string, DeviceTreeNode>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      // Parallel — devices list (config + meta) i tree (online status).
      const [devs, tree] = await Promise.all([
        api.listDevices(),
        api.getDeviceTree().catch(() => [] as DeviceTreeGroup[]),
      ])
      setDevices(devs)
      // /devices/tree zwraca GRUPY per typ z `devices[]` w środku — flatten do
      // map<deviceId, node> żeby `DeviceCard` mógł zlookupować online status.
      // Bug fix 2026-05-14: wcześniej `map.set(node.deviceId, node)` na grupach
      // → `deviceId` był undefined, wszystkie urządzenia pokazywały „offline".
      const map = new Map<string, DeviceTreeNode>()
      for (const group of tree) {
        for (const node of group.devices ?? []) {
          map.set(node.deviceId, node)
        }
      }
      setStatusByDeviceId(map)
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'Błąd ładowania')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])

  return { devices, statusByDeviceId, loading, error, refresh: load }
}
