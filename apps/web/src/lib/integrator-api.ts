import axios from 'axios'
import Cookies from 'js-cookie'

const TOKEN_KEY = 'gl_integrator_token'

export const integratorApi = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api',
})

integratorApi.interceptors.request.use((config) => {
  const token = Cookies.get(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

integratorApi.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      Cookies.remove(TOKEN_KEY)
      window.location.href = '/integrator/login'
    }
    return Promise.reject(err)
  },
)

export function setIntegratorToken(token: string) {
  Cookies.set(TOKEN_KEY, token, { expires: 7, sameSite: 'strict' })
}

export function clearIntegratorToken() {
  Cookies.remove(TOKEN_KEY)
}

export function getIntegratorToken() {
  return Cookies.get(TOKEN_KEY)
}
