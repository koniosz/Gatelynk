import { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, KeyboardAvoidingView, Platform, ScrollView } from 'react-native'
import { router } from 'expo-router'
import { api, setToken, setPendingCredentials } from '../../lib/api'

export default function LoginScreen() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert('Błąd', 'Wpisz email i hasło')
      return
    }
    setLoading(true)
    try {
      const res = await api.post('/resident/auth/login', { email: email.trim(), password })

      // ── Single building → zaloguj od razu
      if (res.data.access_token) {
        await setToken(res.data.access_token)
        router.replace('/(tabs)/home')
        return
      }

      // ── Wiele budynków → przejdź do wyboru
      if (res.data.requiresBuildingSelection) {
        setPendingCredentials(email.trim(), password)
        router.push({
          pathname: '/(auth)/select-building',
          params: { buildings: JSON.stringify(res.data.buildings) },
        })
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? 'Nieprawidłowy email lub hasło'
      Alert.alert('Błąd logowania', msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.logo}>🔷 GateLynk</Text>
          <Text style={styles.subtitle}>Zaloguj się do swojego konta</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            placeholder="twoj@email.pl"
            placeholderTextColor="#9ca3af"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Hasło</Text>
          <TextInput
            style={styles.input}
            placeholder="••••••••"
            placeholderTextColor="#9ca3af"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.85}
          >
            <Text style={styles.buttonText}>{loading ? 'Logowanie…' : 'Zaloguj się'}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container:      { flexGrow: 1, justifyContent: 'center', padding: 24, backgroundColor: '#f9fafb' },
  header:         { marginBottom: 36 },
  logo:           { fontSize: 28, fontWeight: '800', color: '#1e3a5f', marginBottom: 6 },
  subtitle:       { fontSize: 15, color: '#6b7280' },
  form:           { gap: 4 },
  label:          { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 4, marginTop: 12 },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: '#111827',
  },
  button: {
    backgroundColor: '#1e3a5f',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 24,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText:     { color: '#fff', fontWeight: '700', fontSize: 15 },
})
