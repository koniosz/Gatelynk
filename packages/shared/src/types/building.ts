export interface Building {
  id: number
  adminId: number
  name: string
  address: string
  nip: string | null
  regon: string | null
  createdAt: string
}

export interface CreateBuildingDto {
  name: string
  address: string
  nip?: string
  regon?: string
}

export interface UpdateBuildingDto {
  name?: string
  address?: string
  nip?: string
  regon?: string
}
