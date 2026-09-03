import axios from 'axios'
import Cookies from 'js-cookie'

const TOKEN_KEY = 'gl_concierge_token'

export const conciergeApi = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api',
})

conciergeApi.interceptors.request.use((config) => {
  const token = Cookies.get(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

conciergeApi.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      Cookies.remove(TOKEN_KEY)
      window.location.href = '/concierge/login'
    }
    return Promise.reject(err)
  },
)

export function setConciergeToken(token: string) {
  Cookies.set(TOKEN_KEY, token, { expires: 7, sameSite: 'strict' })
}

export function clearConciergeToken() {
  Cookies.remove(TOKEN_KEY)
}

export function getConciergeToken() {
  return Cookies.get(TOKEN_KEY)
}
