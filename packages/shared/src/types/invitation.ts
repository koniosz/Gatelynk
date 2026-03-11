export type InvitationStatus = 'pending' | 'accepted' | 'expired'

export interface Invitation {
  id: number
  residentId: number
  unitId: number
  status: InvitationStatus
  sentAt: string
  expiresAt: string
  acceptedAt: string | null
}

export interface SendInvitationDto {
  residentId: number
  unitId: number
}
