export type SystemUnitTypeCode =
  | 'apartment'
  | 'garage'
  | 'storage'
  | 'pool'
  | 'gym'
  | 'banquet_hall'
  | 'playroom'

export interface UnitType {
  id: number
  buildingId: number | null  // null = system (global)
  code: string
  name: string
  icon: string
  isSystem: boolean
}

export interface Unit {
  id: number
  buildingId: number
  unitTypeId: number
  unitType: UnitType
  number: string
  floor: number | null
  areaSqm: number | null
  description: string | null
  createdAt: string
}

export interface CreateUnitDto {
  unitTypeId: number
  number: string
  floor?: number
  areaSqm?: number
  description?: string
}

export interface CreateUnitTypeDto {
  name: string
  icon: string
}
