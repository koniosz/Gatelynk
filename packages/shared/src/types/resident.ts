export type ResidentRole = 'owner' | 'tenant'

export interface Resident {
  id: number
  buildingId: number
  firstName: string
  lastName: string
  email: string
  phone: string | null
  createdAt: string
}

export interface UnitResident {
  id: number
  unitId: number
  residentId: number
  resident: Resident
  role: ResidentRole
  sinceDate: string
  untilDate: string | null
}

export interface CreateResidentDto {
  firstName: string
  lastName: string
  email: string
  phone?: string
}

export interface AssignResidentDto {
  residentId: number
  role: ResidentRole
  sinceDate: string
}
