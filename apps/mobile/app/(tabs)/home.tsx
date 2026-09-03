import { useState, useCallback, useRef } from 'react'
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Modal, Alert, ScrollView, RefreshControl,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { api, setToken, clearToken } from '../../lib/api'

type Building = {
  residentId: number
  buildingId: number
  buildingName: string
  buildingAddress: string
  unit: string | null
}

type CurrentBuilding = {
  id: number
  name: string
  address: string
}

type AccessPoint = {
  id: number
  label: string
  icon: string
  deviceId: string
  relayIndex: number
  sortOrder: number
}

const ICON_EMOJI: Record<string, string> = {
  door:     '🚪',
  garage:   '🏠',
  gate:     '🚧',
  elevator: '🛗',
  barrier:  '🚦',
}

export default function HomeScreen() {
  const [current, setCurrent]           = useState<CurrentBuilding | null>(null)
  const [myBuildings, setMyBuildings]   = useState<Building[]>([])
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([])
  const [apStatus, setApStatus]         = useState<'loading' | 'ok' | 'error'>('loading')
  const [apError, setApError]           = useState('')
  const [pageLoading, setPageLoading]   = useState(true)
  const [refreshing, setRefreshing]     = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [switching, setSwitching]       = useState<number | null>(null)
  const [btnState, setBtnState]         = useState<Record<number, 'idle' | 'loading' | 'ok' | 'err'>>({})
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  const fetchAccessPoints = useCallback(async () => {
    setApStatus('loading')
    try {
      const res = await api.get('/resident/access-points')
      console.log('[home] access-points response:', JSON.stringify(res.data))
      setAccessPoints(res.data ?? [])
      setApStatus('ok')
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? 'unknown'
      console.log('[home] access-points error:', msg)
      setApError(msg)
      setApStatus('error')
    }
  }, [])

  const fetchBuilding = useCallback(async () => {
    try {
      const [bldRes, listRes] = await Promise.all([
        api.get('/resident/building'),
        api.get('/resident/my-buildings'),
      ])
      setCurrent(bldRes.data)
      setMyBuildings(listRes.data)
    } catch {
      router.replace('/(auth)/login')
    } finally {
      setPageLoading(false)
      setRefreshing(false)
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      console.log('[home] focused — loading data')
      fetchBuilding()
      fetchAccessPoints()
    }, [fetchBuilding, fetchAccessPoints]),
  )

  const handleSwitch = async (option: Building) => {
    if (option.buildingId === current?.id) { setSwitcherOpen(false); return }
    setSwitching(option.residentId)
    try {
      const res = await api.post('/resident/auth/switch-building', { residentId: option.residentId })
      await setToken(res.data.access_token)
      setSwitcherOpen(false)
      setPageLoading(true)
      await fetchBuilding()
      await fetchAccessPoints()
    } catch {
      Alert.alert('Błąd', 'Nie udało się przełączyć nieruchomości')
    } finally {
      setSwitching(null)
    }
  }

  const handleOpen = async (ap: AccessPoint) => {
    if (btnState[ap.id] === 'loading') return
    if (timers.current[ap.id]) clearTimeout(timers.current[ap.id])
    setBtnState((prev) => ({ ...prev, [ap.id]: 'loading' }))
    try {
      await api.post(`/resident/access-points/${ap.id}/open`)
      setBtnState((prev) => ({ ...prev, [ap.id]: 'ok' }))
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? 'Błąd'
      Alert.alert('Błąd otwarcia', msg)
      setBtnState((prev) => ({ ...prev, [ap.id]: 'err' }))
    } finally {
      timers.current[ap.id] = setTimeout(() => {
        setBtnState((prev) => ({ ...prev, [ap.id]: 'idle' }))
      }, 3000)
    }
  }

  if (pageLoading) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    )
  }

  return (
    <View style={s.container}>

      {/* Header */}
      <View style={s.header}>
        <View>
          <Text style={s.logo}>🔷 GateLynk</Text>
          {current && (
            <TouchableOpacity
              style={s.pill}
              onPress={() => myBuildings.length > 1 && setSwitcherOpen(true)}
              activeOpacity={myBuildings.length > 1 ? 0.7 : 1}
            >
              <Text style={s.pillText} numberOfLines={1}>{current.name}</Text>
              {myBuildings.length > 1 && <Text style={s.pillArrow}>⌄</Text>}
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity onPress={async () => { await clearToken(); router.replace('/(auth)/login') }}>
          <Text style={s.logout}>Wyloguj</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchBuilding(); fetchAccessPoints() }}
            tintColor="#2563eb"
          />
        }
      >

        {/* ── Domofony / wejścia — NA GÓRZE ── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Domofony i wejścia</Text>

          {apStatus === 'loading' && (
            <View style={s.statusBox}>
              <ActivityIndicator color="#2563eb" />
              <Text style={s.statusText}>Ładowanie…</Text>
            </View>
          )}

          {apStatus === 'error' && (
            <TouchableOpacity style={s.errorBox} onPress={fetchAccessPoints} activeOpacity={0.7}>
              <Text style={s.errorTitle}>⚠️ Błąd połączenia</Text>
              <Text style={s.errorMsg}>{apError}</Text>
              <Text style={s.errorRetry}>Dotknij aby ponowić ↺</Text>
            </TouchableOpacity>
          )}

          {apStatus === 'ok' && accessPoints.length === 0 && (
            <View style={s.emptyBox}>
              <Text style={s.emptyText}>Brak skonfigurowanych wejść</Text>
              <Text style={s.emptyHint}>Administrator nie dodał jeszcze punktów dostępu</Text>
            </View>
          )}

          {apStatus === 'ok' && accessPoints.length > 0 && (
            <View style={s.grid}>
              {accessPoints.map((ap) => {
                const st = btnState[ap.id] ?? 'idle'
                return (
                  <TouchableOpacity
                    key={ap.id}
                    style={[s.card, st === 'ok' && s.cardOk, st === 'err' && s.cardErr]}
                    onPress={() => handleOpen(ap)}
                    disabled={st === 'loading'}
                    activeOpacity={0.75}
                  >
                    <Text style={s.cardIcon}>
                      {st === 'ok' ? '✅' : st === 'err' ? '❌' : (ICON_EMOJI[ap.icon] ?? '🚪')}
                    </Text>
                    <Text style={s.cardLabel} numberOfLines={2}>{ap.label}</Text>
                    <View style={[s.btn, st === 'ok' && s.btnOk, st === 'err' && s.btnErr]}>
                      {st === 'loading'
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Text style={s.btnText}>
                            {st === 'ok' ? 'Otwarto!' : st === 'err' ? 'Błąd' : 'Otwórz'}
                          </Text>
                      }
                    </View>
                  </TouchableOpacity>
                )
              })}
            </View>
          )}
        </View>

        {/* ── Budynek ── */}
        {current && (
          <View style={s.buildingCard}>
            <Text style={s.buildingLabel}>Aktywna nieruchomość</Text>
            <Text style={s.buildingName}>{current.name}</Text>
            <Text style={s.buildingAddr}>{current.address}</Text>
            {myBuildings.length > 1 && (
              <TouchableOpacity onPress={() => setSwitcherOpen(true)} style={{ marginTop: 10 }}>
                <Text style={s.switchLink}>🔄 Zmień nieruchomość ({myBuildings.length})</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

      </ScrollView>

      {/* Building Switcher Modal */}
      <Modal visible={switcherOpen} transparent animationType="slide" onRequestClose={() => setSwitcherOpen(false)}>
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={() => setSwitcherOpen(false)} />
        <View style={s.sheet}>
          <View style={s.handle} />
          <Text style={s.sheetTitle}>Wybierz nieruchomość</Text>
          <FlatList
            data={myBuildings}
            keyExtractor={(item) => String(item.residentId)}
            contentContainerStyle={{ gap: 10, paddingBottom: 24 }}
            renderItem={({ item }) => {
              const isCur = item.buildingId === current?.id
              return (
                <TouchableOpacity
                  style={[s.sheetRow, isCur && s.sheetRowActive]}
                  onPress={() => handleSwitch(item)}
                  disabled={switching !== null}
                  activeOpacity={0.8}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[s.sheetRowName, isCur && { color: '#2563eb' }]}>{item.buildingName}</Text>
                    <Text style={s.sheetRowAddr}>{item.buildingAddress}</Text>
                    {item.unit && <Text style={s.sheetRowUnit}>Lokal {item.unit}</Text>}
                  </View>
                  {isCur && <Text style={{ color: '#2563eb', fontSize: 18 }}>✓</Text>}
                  {switching === item.residentId && <ActivityIndicator size="small" color="#2563eb" />}
                </TouchableOpacity>
              )
            }}
          />
        </View>
      </Modal>

    </View>
  )
}

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#f9fafb' },
  center:      { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16 },
  logo:        { fontSize: 18, fontWeight: '800', color: '#1e3a5f', marginBottom: 4 },
  pill:        { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#eff6ff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, alignSelf: 'flex-start' },
  pillText:    { fontSize: 13, color: '#2563eb', fontWeight: '600', maxWidth: 200 },
  pillArrow:   { fontSize: 12, color: '#2563eb' },
  logout:      { fontSize: 13, color: '#ef4444', fontWeight: '600', padding: 8 },

  section:     { paddingHorizontal: 16, paddingTop: 8, marginBottom: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: '#111827', marginBottom: 12 },

  statusBox:   { flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#e5e7eb' },
  statusText:  { color: '#6b7280', fontSize: 14 },

  errorBox:    { backgroundColor: '#fef9c3', borderRadius: 12, borderWidth: 1, borderColor: '#fde047', padding: 16, gap: 4 },
  errorTitle:  { fontSize: 14, fontWeight: '700', color: '#854d0e' },
  errorMsg:    { fontSize: 12, color: '#92400e' },
  errorRetry:  { fontSize: 12, color: '#2563eb', fontWeight: '600', marginTop: 4 },

  emptyBox:    { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#e5e7eb', padding: 20, alignItems: 'center' },
  emptyText:   { fontSize: 14, fontWeight: '600', color: '#374151', marginBottom: 4 },
  emptyHint:   { fontSize: 12, color: '#9ca3af', textAlign: 'center' },

  grid:        { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: {
    width: '47%', backgroundColor: '#fff', borderRadius: 16,
    padding: 16, borderWidth: 1.5, borderColor: '#e5e7eb',
    alignItems: 'center', gap: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 6, elevation: 3,
  },
  cardOk:      { borderColor: '#86efac', backgroundColor: '#f0fdf4' },
  cardErr:     { borderColor: '#fca5a5', backgroundColor: '#fef2f2' },
  cardIcon:    { fontSize: 36 },
  cardLabel:   { fontSize: 13, fontWeight: '600', color: '#1f2937', textAlign: 'center', minHeight: 36 },
  btn:         { width: '100%', paddingVertical: 11, backgroundColor: '#2563eb', borderRadius: 10, alignItems: 'center', justifyContent: 'center', minHeight: 40 },
  btnOk:       { backgroundColor: '#16a34a' },
  btnErr:      { backgroundColor: '#dc2626' },
  btnText:     { fontSize: 15, fontWeight: '700', color: '#fff' },

  buildingCard: { marginHorizontal: 16, backgroundColor: '#fff', borderRadius: 16, padding: 18, borderWidth: 1, borderColor: '#e5e7eb' },
  buildingLabel: { fontSize: 11, fontWeight: '600', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  buildingName: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 2 },
  buildingAddr: { fontSize: 13, color: '#6b7280' },
  switchLink:  { fontSize: 13, color: '#2563eb', fontWeight: '600' },

  backdrop:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet:       { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingTop: 12, maxHeight: '70%' },
  handle:      { width: 40, height: 4, backgroundColor: '#e5e7eb', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  sheetTitle:  { fontSize: 20, fontWeight: '800', color: '#111827', marginBottom: 16 },
  sheetRow:    { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#f9fafb', borderRadius: 14, padding: 14, borderWidth: 1.5, borderColor: '#e5e7eb' },
  sheetRowActive: { borderColor: '#bfdbfe', backgroundColor: '#eff6ff' },
  sheetRowName: { fontSize: 15, fontWeight: '700', color: '#111827' },
  sheetRowAddr: { fontSize: 12, color: '#6b7280', marginTop: 1 },
  sheetRowUnit: { fontSize: 12, color: '#2563eb', fontWeight: '600', marginTop: 3 },
})
