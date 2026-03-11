import axios from 'axios'
import * as SecureStore from 'expo-secure-store'

const TOKEN_KEY = 'gl_token'
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/api'

export const api = axios.create({ baseURL: API_URL })

api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

export async function setToken(token: string) {
  await SecureStore.setItemAsync(TOKEN_KEY, token)
}

export async function clearToken() {
  await SecureStore.deleteItemAsync(TOKEN_KEY)
}

export async function getToken() {
  return SecureStore.getItemAsync(TOKEN_KEY)
}
