import axios from 'axios'
import Cookies from 'js-cookie'

const TOKEN_KEY = 'gl_token'

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api',
})

api.interceptors.request.use((config) => {
  const token = Cookies.get(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      Cookies.remove(TOKEN_KEY)
      window.location.href = '/login'
    }
    return Promise.reject(err)
  },
)

export function setToken(token: string) {
  Cookies.set(TOKEN_KEY, token, { expires: 7, sameSite: 'strict' })
}

export function clearToken() {
  Cookies.remove(TOKEN_KEY)
}

export function getToken() {
  return Cookies.get(TOKEN_KEY)
}
