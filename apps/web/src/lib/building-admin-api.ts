import axios from 'axios'
import Cookies from 'js-cookie'

const TOKEN_KEY = 'gl_ba_token'

export const buildingAdminApi = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api',
})

buildingAdminApi.interceptors.request.use((config) => {
  const token = Cookies.get(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

buildingAdminApi.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      Cookies.remove(TOKEN_KEY)
      window.location.href = '/building-admin/login'
    }
    return Promise.reject(err)
  },
)

export function setBaToken(token: string) {
  Cookies.set(TOKEN_KEY, token, { expires: 7, sameSite: 'strict' })
}

export function clearBaToken() {
  Cookies.remove(TOKEN_KEY)
}

export function getBaToken() {
  return Cookies.get(TOKEN_KEY)
}
