export type LicensePlanCode = 'starter' | 'standard' | 'pro'

export type LicenseKeyStatus = 'active' | 'used' | 'expired' | 'revoked'

export interface LicensePlan {
  id: number
  code: LicensePlanCode
  name: string
  maxUnits: number | null      // null = unlimited
  maxBuildings: number | null
  maxAdmins: number
}

export interface LicenseKey {
  id: string
  key: string
  planId: number
  plan: LicensePlan
  status: LicenseKeyStatus
  validUntil: string | null
  createdAt: string
  activatedBy: number | null
  activatedAt: string | null
}

// API payloads
export interface ActivateLicenseDto {
  key: string
}

export interface ActivateLicenseResponse {
  success: boolean
  plan: LicensePlan
  validUntil: string | null
}
