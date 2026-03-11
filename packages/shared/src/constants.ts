export const LICENSE_PLANS = {
  starter: {
    code: 'starter' as const,
    name: 'Starter',
    maxUnits: 50,
    maxBuildings: 1,
    maxAdmins: 1,
  },
  standard: {
    code: 'standard' as const,
    name: 'Standard',
    maxUnits: 200,
    maxBuildings: 5,
    maxAdmins: 3,
  },
  pro: {
    code: 'pro' as const,
    name: 'Pro',
    maxUnits: null,
    maxBuildings: null,
    maxAdmins: 10,
  },
}

export const SYSTEM_UNIT_TYPES = [
  { code: 'apartment', name: 'Mieszkanie', icon: 'home' },
  { code: 'garage', name: 'Garaż', icon: 'car' },
  { code: 'storage', name: 'Komórka lokatorska', icon: 'archive' },
  { code: 'pool', name: 'Basen', icon: 'waves' },
  { code: 'gym', name: 'Siłownia', icon: 'dumbbell' },
  { code: 'banquet_hall', name: 'Sala bankietowa', icon: 'party-popper' },
  { code: 'playroom', name: 'Sala zabaw', icon: 'gamepad' },
] as const

export const INVITATION_EXPIRES_DAYS = 7

export const LICENSE_KEY_REGEX = /^GL-(STRT|STND|PRO_)-[A-Z0-9]{4}-[A-Z0-9]{4}-\d{4}$/
