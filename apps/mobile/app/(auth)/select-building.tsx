import { useLocalSearchParams, router } from 'expo-router'
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native'
import { useState } from 'react'
import { api, setToken, consumePendingCredentials } from '../../lib/api'

type BuildingOption = {
  residentId: number
  buildingId: number
  buildingName: string
  buildingAddress: string
  unit: string | null
}

export default function SelectBuildingScreen() {
  const params  = useLocalSearchParams<{ buildings: string }>()
  const options: BuildingOption[] = JSON.parse(params.buildings ?? '[]')
  const [loadingId, setLoadingId] = useState<number | null>(null)

  const handleSelect = async (option: BuildingOption) => {
    const creds = consumePendingCredentials()
    if (!creds) {
      Alert.alert('Błąd', 'Sesja wygasła — zaloguj się ponownie')
      router.replace('/(auth)/login')
      return
    }

    setLoadingId(option.residentId)
    try {
      const res = await api.post('/resident/auth/select-building', {
        email:      creds.email,
        password:   creds.password,
        residentId: option.residentId,
      })
      await setToken(res.data.access_token)
      router.replace('/(tabs)/home')
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? 'Nie udało się zalogować'
      Alert.alert('Błąd', msg)
    } finally {
      setLoadingId(null)
    }
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.back} onPress={() => router.back()}>
        <Text style={styles.backText}>← Wróć</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Wybierz nieruchomość</Text>
      <Text style={styles.subtitle}>
        Twoje konto jest powiązane z {options.length} nieruchomościami.{'\n'}
        Wybierz, do której chcesz się zalogować.
      </Text>

      <FlatList
        data={options}
        keyExtractor={(item) => String(item.residentId)}
        contentContainerStyle={{ gap: 12, paddingBottom: 32 }}
        renderItem={({ item }) => {
          const loading = loadingId === item.residentId
          return (
            <TouchableOpacity
              style={[styles.card, loading && styles.cardLoading]}
              onPress={() => handleSelect(item)}
              disabled={loadingId !== null}
              activeOpacity={0.8}
            >
              <View style={styles.cardIcon}>
                <Text style={styles.cardIconText}>🏢</Text>
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.cardTitle}>{item.buildingName}</Text>
                <Text style={styles.cardAddress}>{item.buildingAddress}</Text>
                {item.unit && (
                  <View style={styles.unitBadge}>
                    <Text style={styles.unitBadgeText}>Lokal {item.unit}</Text>
                  </View>
                )}
              </View>
              {loading
                ? <ActivityIndicator size="small" color="#2563eb" />
                : <Text style={styles.arrow}>›</Text>
              }
            </TouchableOpacity>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#f9fafb', padding: 24, paddingTop: 60 },
  back:         { marginBottom: 24 },
  backText:     { fontSize: 15, color: '#2563eb', fontWeight: '600' },
  title:        { fontSize: 24, fontWeight: '800', color: '#111827', marginBottom: 8 },
  subtitle:     { fontSize: 14, color: '#6b7280', marginBottom: 28, lineHeight: 20 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardLoading: { opacity: 0.6 },
  cardIcon: {
    width: 48, height: 48, borderRadius: 12,
    backgroundColor: '#eff6ff',
    justifyContent: 'center', alignItems: 'center',
    flexShrink: 0,
  },
  cardIconText:    { fontSize: 22 },
  cardBody:        { flex: 1 },
  cardTitle:       { fontSize: 16, fontWeight: '700', color: '#111827', marginBottom: 2 },
  cardAddress:     { fontSize: 13, color: '#6b7280' },
  unitBadge: {
    marginTop: 6,
    alignSelf: 'flex-start',
    backgroundColor: '#eff6ff',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  unitBadgeText:   { fontSize: 12, color: '#2563eb', fontWeight: '600' },
  arrow:           { fontSize: 22, color: '#d1d5db', fontWeight: '300' },
})
