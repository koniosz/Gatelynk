'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { buildingAdminApi } from '@/lib/building-admin-api'
import { unitIconEmoji } from '@/lib/unit-icon'
import { VehiclesTab, BrandingTab } from '@/app/(dashboard)/buildings/[id]/page'
import { TagPicker, TagChips } from '@/components/TagPicker'

type Tab = 'residents' | 'units' | 'stairwells' | 'notifications' | 'vehicles' | 'guests' | 'tickets' | 'branding' | 'payments'

export default function BaBuildingDetailPage() {
  const { id } = useParams()
  const router = useRouter()
  const [building, setBuilding] = useState<any>(null)
  const [tab, setTab] = useState<Tab>('residents')
  const [brandingUploading, setBrandingUploading] = useState<'logo' | 'bg' | null>(null)

  // Units
  const [units, setUnits] = useState<any[]>([])
  const [unitTypes, setUnitTypes] = useState<any[]>([])
  const [showAddUnit, setShowAddUnit] = useState(false)
  const [uTypeId, setUTypeId] = useState('')
  const [uNumber, setUNumber] = useState('')
  const [uFloor, setUFloor] = useState('')
  const [uArea, setUArea] = useState('')
  const [uDesc, setUDesc] = useState('')
  const [uStairwellId, setUStairwellId] = useState('')
  const [uAdding, setUAdding] = useState(false)
  const [uError, setUError] = useState<string | null>(null)

  // Unit type creation
  const [showAddUnitType, setShowAddUnitType] = useState(false)
  const [utName, setUtName] = useState('')
  const [utIcon, setUtIcon] = useState('🏠')
  const [utIsCommonArea, setUtIsCommonArea] = useState(false)
  const [utAdding, setUtAdding] = useState(false)
  const [utError, setUtError] = useState<string | null>(null)

  // Common area settings
  const [settingsUnit, setSettingsUnit] = useState<any | null>(null)
  const [sMaxSlot, setSMaxSlot] = useState('60')
  const [sOpenTime, setSOpenTime] = useState('08:00')
  const [sCloseTime, setSCloseTime] = useState('22:00')
  const [sIsPaid, setSIsPaid] = useState(false)
  const [sPricePerHour, setSPricePerHour] = useState('')
  const [sSaving, setSSaving] = useState(false)
  const [sError, setSError] = useState<string | null>(null)

  const openSettings = (u: any) => {
    setSettingsUnit(u)
    const s = u.commonAreaSettings
    setSMaxSlot(s?.maxSlotMinutes != null ? String(s.maxSlotMinutes) : '60')
    setSOpenTime(s?.openTime ?? '08:00')
    setSCloseTime(s?.closeTime ?? '22:00')
    setSIsPaid(s?.isPaid ?? false)
    setSPricePerHour(s?.pricePerHour != null ? String(s.pricePerHour) : '')
    setSError(null)
  }

  const openResidentModal = (r: any) => {
    setSelResident(r); setReEditMode(false)
    setReFirst(r.firstName); setReLast(r.lastName)
    setReEmail(r.email); setRePhone(r.phone ?? ''); setReErrMsg(null)
    setReNotifTitle(''); setReNotifBody(''); setReNotifResult(null)
    setRePwNew(''); setRePwConfirm(''); setRePwResult(null)
  }

  const handleSendReNotif = async (e: React.FormEvent) => {
    e.preventDefault(); setReNotifSending(true); setReNotifResult(null)
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${id}/notifications`, {
        title: reNotifTitle, body: reNotifBody, residentId: selResident.id,
      })
      setReNotifResult('Wysłano!')
      setReNotifTitle(''); setReNotifBody('')
    } catch (err: any) { setReNotifResult('Błąd: ' + (err?.response?.data?.message ?? 'nieznany błąd')) }
    finally { setReNotifSending(false) }
  }

  const handleSetRePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (rePwNew !== rePwConfirm) { setRePwResult('Hasła nie są zgodne'); return }
    if (rePwNew.length < 6) { setRePwResult('Hasło musi mieć co najmniej 6 znaków'); return }
    setRePwSaving(true); setRePwResult(null)
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${id}/residents/${selResident.id}/set-password`, { password: rePwNew })
      setRePwResult('✓ Hasło zostało ustawione')
      setRePwNew(''); setRePwConfirm('')
    } catch (err: any) { setRePwResult('Błąd: ' + (err?.response?.data?.message ?? 'nieznany błąd')) }
    finally { setRePwSaving(false) }
  }

  const handleSaveResident = async (e: React.FormEvent) => {
    e.preventDefault(); setReSaving(true); setReErrMsg(null)
    try {
      const res = await buildingAdminApi.patch(`/building-admin/buildings/${id}/residents/${selResident.id}`, {
        firstName: reFirst, lastName: reLast, email: reEmail, phone: rePhone || undefined,
      })
      setSelResident((prev: any) => ({ ...prev, ...res.data }))
      setReEditMode(false)
      buildingAdminApi.get(`/building-admin/buildings/${id}/residents`).then((r) => setResidents(r.data))
    } catch (err: any) { setReErrMsg(err?.response?.data?.message ?? 'Błąd zapisu') }
    finally { setReSaving(false) }
  }

  const handleResidentAvatarUpload = async (residentId: number, file: File) => {
    setAvatarUploading(residentId)
    try {
      const reader = new FileReader()
      const avatarBase64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string
          // Strip data URI prefix if present
          const b64 = result.includes(',') ? result.split(',')[1] : result
          resolve(b64)
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      await buildingAdminApi.patch(`/building-admin/buildings/${id}/residents/${residentId}/avatar`, { avatarBase64 })
      buildingAdminApi.get(`/building-admin/buildings/${id}/residents`).then((r) => setResidents(r.data))
    } catch (err: any) {
      alert('Błąd przesyłania zdjęcia: ' + (err?.response?.data?.message ?? 'nieznany błąd'))
    } finally {
      setAvatarUploading(null)
    }
  }

  const openUnitModal = async (u: any) => {
    setSelUnit(u); setUeEditMode(false)
    setUeNumber(u.number); setUeFloor(u.floor != null ? String(u.floor) : '')
    setUeStairwellId(u.stairwellId != null ? String(u.stairwellId) : '')
    setUeTypeId(String(u.unitTypeId)); setUeErrMsg(null); setUeResidents([])
    setUeShowAssignForm(false); setUeAssignResidentId(''); setUeAssignRole('OWNER')
    setUeAssignDate(''); setUeAssignError(null); setUeUnassigning(null)
    try {
      const res = await buildingAdminApi.get(`/building-admin/buildings/${id}/units/${u.id}`)
      setUeResidents(res.data.unitResidents ?? [])
    } catch {}
  }

  const handleSaveUnit = async (e: React.FormEvent) => {
    e.preventDefault(); setUeSaving(true); setUeErrMsg(null)
    try {
      const res = await buildingAdminApi.patch(`/building-admin/buildings/${id}/units/${selUnit.id}`, {
        number: ueNumber,
        floor: ueFloor !== '' ? +ueFloor : null,
        stairwellId: ueStairwellId ? +ueStairwellId : null,
        unitTypeId: +ueTypeId,
      })
      setSelUnit((prev: any) => ({ ...prev, ...res.data }))
      setUeEditMode(false)
      buildingAdminApi.get(`/building-admin/buildings/${id}/units`).then((r) => setUnits(r.data))
    } catch (err: any) { setUeErrMsg(err?.response?.data?.message ?? 'Błąd zapisu') }
    finally { setUeSaving(false) }
  }

  const refreshUeResidents = async (unitId: number) => {
    const res = await buildingAdminApi.get(`/building-admin/buildings/${id}/units/${unitId}`)
    setUeResidents(res.data.unitResidents ?? [])
    buildingAdminApi.get(`/building-admin/buildings/${id}/residents`).then((r) => setResidents(r.data))
  }

  const handleAssignResident = async (e: React.FormEvent) => {
    e.preventDefault()
    setUeAssigning(true); setUeAssignError(null)
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${id}/units/${selUnit.id}/residents`, {
        residentId: +ueAssignResidentId,
        role: ueAssignRole,
        sinceDate: ueAssignDate || new Date().toISOString().slice(0, 10),
      })
      setUeAssignResidentId(''); setUeAssignRole('OWNER'); setUeAssignDate('')
      setUeShowAssignForm(false)
      await refreshUeResidents(selUnit.id)
    } catch (err: any) {
      setUeAssignError(err?.response?.data?.message ?? 'Błąd przypisywania')
    } finally { setUeAssigning(false) }
  }

  const handleUnassignResident = async (assignmentId: number) => {
    if (!confirm('Odpiąć tego mieszkańca od lokalu?')) return
    setUeUnassigning(assignmentId)
    try {
      await buildingAdminApi.delete(`/building-admin/buildings/${id}/units/${selUnit.id}/residents/${assignmentId}`)
      await refreshUeResidents(selUnit.id)
    } catch { } finally { setUeUnassigning(null) }
  }

  const openVehicleModal = (v: any) => {
    setSelVehicle(v); setVeEditMode(false)
    setVeMake(v.make); setVeModel(v.model ?? ''); setVeColor(v.color)
    setVePlate(v.licensePlate); setVeResidentId(String(v.residentId ?? ''))
    setVeTags(Array.isArray(v.tags) ? v.tags : [])
    setVeErrMsg(null)
  }

  const handleSaveVehicle = async (e: React.FormEvent) => {
    e.preventDefault(); setVeSaving(true); setVeErrMsg(null)
    try {
      const res = await buildingAdminApi.patch(`/building-admin/buildings/${id}/vehicles/${selVehicle.id}`, {
        make: veMake, model: veModel || undefined, color: veColor,
        licensePlate: vePlate,
        residentId: veResidentId ? +veResidentId : undefined,
        tags: veTags,
      })
      setSelVehicle(res.data)
      setVeEditMode(false)
      loadVehicles()
    } catch (err: any) { setVeErrMsg(err?.response?.data?.message ?? 'Błąd zapisu') }
    finally { setVeSaving(false) }
  }

  // Residents
  const [residents, setResidents] = useState<any[]>([])
  const [showAddResident, setShowAddResident] = useState(false)
  const [rFirst, setRFirst] = useState('')
  const [rLast, setRLast] = useState('')
  const [rEmail, setREmail] = useState('')
  const [rPhone, setRPhone] = useState('')
  const [rAdding, setRAdding] = useState(false)
  const [rError, setRError] = useState<string | null>(null)

  // Avatar upload state
  const [avatarUploading, setAvatarUploading] = useState<number | null>(null)

  // Stairwells
  const [showAddSw, setShowAddSw] = useState(false)
  const [swName, setSwName] = useState('')
  const [swAdding, setSwAdding] = useState(false)

  // Notifications
  const [notifTitle, setNotifTitle] = useState('')
  const [notifBody, setNotifBody] = useState('')
  const [notifResidentId, setNotifResidentId] = useState('')
  const [notifSending, setNotifSending] = useState(false)
  const [notifResult, setNotifResult] = useState<string | null>(null)

  // Pojazdy
  const [vehicles, setVehicles] = useState<any[]>([])
  const [showAddVehicle, setShowAddVehicle] = useState(false)
  const [vResidentId, setVResidentId] = useState('')
  const [vMake, setVMake] = useState('')
  const [vModel, setVModel] = useState('')
  const [vColor, setVColor] = useState('')
  const [vPlate, setVPlate] = useState('')
  const [vAdding, setVAdding] = useState(false)
  const [vError, setVError] = useState<string | null>(null)

  // Karta mieszkańca
  const [selResident, setSelResident] = useState<any>(null)
  const [reEditMode, setReEditMode] = useState(false)
  const [reFirst, setReFirst] = useState('')
  const [reLast, setReLast] = useState('')
  const [reEmail, setReEmail] = useState('')
  const [rePhone, setRePhone] = useState('')
  const [reSaving, setReSaving] = useState(false)
  const [reErrMsg, setReErrMsg] = useState<string | null>(null)
  const [reNotifTitle, setReNotifTitle] = useState('')
  const [reNotifBody, setReNotifBody] = useState('')
  const [reNotifSending, setReNotifSending] = useState(false)
  const [reNotifResult, setReNotifResult] = useState<string | null>(null)

  // Hasło mieszkańca
  const [rePwNew, setRePwNew] = useState('')
  const [rePwConfirm, setRePwConfirm] = useState('')
  const [rePwSaving, setRePwSaving] = useState(false)
  const [rePwResult, setRePwResult] = useState<string | null>(null)

  // Karta lokalu
  const [selUnit, setSelUnit] = useState<any>(null)
  const [ueEditMode, setUeEditMode] = useState(false)
  const [ueNumber, setUeNumber] = useState('')
  const [ueFloor, setUeFloor] = useState('')
  const [ueStairwellId, setUeStairwellId] = useState('')
  const [ueTypeId, setUeTypeId] = useState('')
  const [ueResidents, setUeResidents] = useState<any[]>([])
  const [ueSaving, setUeSaving] = useState(false)
  const [ueErrMsg, setUeErrMsg] = useState<string | null>(null)
  // Przypisywanie/odpinanie mieszkańca od lokalu
  const [ueShowAssignForm, setUeShowAssignForm] = useState(false)
  const [ueAssignResidentId, setUeAssignResidentId] = useState('')
  const [ueAssignRole, setUeAssignRole] = useState('OWNER')
  const [ueAssignDate, setUeAssignDate] = useState('')
  const [ueAssigning, setUeAssigning] = useState(false)
  const [ueAssignError, setUeAssignError] = useState<string | null>(null)
  const [ueUnassigning, setUeUnassigning] = useState<number | null>(null)

  // Karta pojazdu
  const [selVehicle, setSelVehicle] = useState<any>(null)
  const [veEditMode, setVeEditMode] = useState(false)
  const [veMake, setVeMake] = useState('')
  const [veModel, setVeModel] = useState('')
  const [veColor, setVeColor] = useState('')
  const [vePlate, setVePlate] = useState('')
  const [veResidentId, setVeResidentId] = useState('')
  // Faza 2 wprowadziła `tags` na pojeździe, ale ten modal został pominięty
  // — admin nie mógł edytować ich tutaj (tylko z LprViewer). Naprawione
  // 2026-05-11 na prośbę usera.
  const [veTags, setVeTags] = useState<string[]>([])
  const [veSaving, setVeSaving] = useState(false)
  const [veErrMsg, setVeErrMsg] = useState<string | null>(null)

  // Global search
  const [globalSearch, setGlobalSearch] = useState('')

  // Tickets
  const [tickets, setTickets] = useState<any[]>([])
  const [ticketFilter, setTicketFilter] = useState<'ALL' | 'OPEN' | 'IN_PROGRESS' | 'DONE'>('ALL')
  const [expandedTicket, setExpandedTicket] = useState<number | null>(null)
  const [replyBody, setReplyBody] = useState<Record<number, string>>({})
  const [replySending, setReplySending] = useState<number | null>(null)

  const loadVehicles = useCallback(async () => {
    try {
      const res = await buildingAdminApi.get(`/building-admin/buildings/${id}/vehicles`)
      setVehicles(res.data)
    } catch { /* ignore */ }
  }, [id])

  // Goście (Faza 2 bety Villa Natura). Admin może zaprosić, edytować
  // i anulować gościa „za" mieszkańca (np. ekipa serwisowa, taksówka).
  const [guests, setGuests] = useState<any[]>([])
  const loadGuests = useCallback(async () => {
    try {
      const res = await buildingAdminApi.get(`/building-admin/buildings/${id}/guests`)
      setGuests(res.data)
    } catch { /* ignore */ }
  }, [id])

  // Formularz nowego/edytowanego gościa (modal). `editingGuest === null`
  // i `showGuestForm === true` → tryb dodawania. `editingGuest = obiekt` → edycja.
  const [showGuestForm, setShowGuestForm] = useState(false)
  const [editingGuest, setEditingGuest] = useState<any | null>(null)
  const [gfResidentId, setGfResidentId] = useState('')
  const [gfName, setGfName] = useState('')
  const [gfPhone, setGfPhone] = useState('')
  const [gfEmail, setGfEmail] = useState('')
  const [gfHasVehicle, setGfHasVehicle] = useState(false)
  const [gfPlate, setGfPlate] = useState('')
  const [gfValidFrom, setGfValidFrom] = useState('')
  const [gfValidTo, setGfValidTo] = useState('')
  const [gfSaving, setGfSaving] = useState(false)
  const [gfError, setGfError] = useState<string | null>(null)
  const [cancellingGuestId, setCancellingGuestId] = useState<number | null>(null)
  const [resendingGuestId, setResendingGuestId] = useState<number | null>(null)

  // Domyślne wartości formularza: od teraz do +24h. Edytując — bierzemy
  // wartości z istniejącego obiektu (gość trafia do `editingGuest`).
  const openGuestForm = (g: any | null) => {
    setEditingGuest(g)
    setGfError(null)
    if (g) {
      setGfResidentId(String(g.residentId))
      setGfName(g.name)
      setGfPhone(g.phone ?? '')
      setGfEmail(g.email ?? '')
      setGfHasVehicle(!!g.vehiclePlate)
      setGfPlate(g.vehiclePlate ?? '')
      setGfValidFrom(toLocalInput(g.validFrom))
      setGfValidTo(toLocalInput(g.validTo))
    } else {
      const now = new Date()
      const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000)
      setGfResidentId('')
      setGfName('')
      setGfPhone('')
      setGfEmail('')
      setGfHasVehicle(false)
      setGfPlate('')
      setGfValidFrom(toLocalInput(now))
      setGfValidTo(toLocalInput(tomorrow))
    }
    setShowGuestForm(true)
  }
  const closeGuestForm = () => {
    setShowGuestForm(false)
    setEditingGuest(null)
  }

  const submitGuestForm = async (e: React.FormEvent) => {
    e.preventDefault()
    if (gfSaving) return
    setGfSaving(true); setGfError(null)
    try {
      const trimmedPlate = gfPlate.trim().toUpperCase()
      const validFromISO = new Date(gfValidFrom).toISOString()
      const validToISO = new Date(gfValidTo).toISOString()

      if (editingGuest) {
        // PATCH — wysyłamy tylko zmienione pola, ale dla prostoty zawsze wszystkie
        // (backend i tak robi UPDATE tylko tego, co przyszło).
        await buildingAdminApi.patch(`/building-admin/buildings/${id}/guests/${editingGuest.id}`, {
          name: gfName.trim(),
          phone: gfPhone.trim() === '' ? null : gfPhone.trim(),
          vehiclePlate: gfHasVehicle ? trimmedPlate : null,
          validFrom: validFromISO,
          validTo: validToISO,
        })
      } else {
        if (!gfResidentId) throw new Error('Wybierz mieszkańca')
        await buildingAdminApi.post(`/building-admin/buildings/${id}/guests`, {
          residentId: +gfResidentId,
          name: gfName.trim(),
          phone: gfPhone.trim() || undefined,
          vehiclePlate: gfHasVehicle ? trimmedPlate : undefined,
          // Gdy email podany → backend wysyła Resend email z linkiem do portalu.
          email: gfEmail.trim() || undefined,
          validFrom: validFromISO,
          validTo: validToISO,
        })
      }
      await loadGuests()
      closeGuestForm()
    } catch (err: any) {
      setGfError(err?.response?.data?.message ?? err?.message ?? 'Błąd zapisu')
    } finally {
      setGfSaving(false)
    }
  }

  const cancelGuestById = async (guestId: number) => {
    if (!confirm('Anulować zaproszenie? Gość nie wjedzie więcej i tablica zniknie z LPR.')) return
    setCancellingGuestId(guestId)
    try {
      await buildingAdminApi.delete(`/building-admin/buildings/${id}/guests/${guestId}`)
      await loadGuests()
    } catch (err: any) {
      alert(err?.response?.data?.message ?? 'Nie udało się anulować zaproszenia')
    } finally {
      setCancellingGuestId(null)
    }
  }

  /**
   * Wysyła ponownie email z linkiem do portalu zaproszenia. Jeśli gość nie ma
   * zapisanego emaila, prompt o niego (zostanie też zapisany w bazie).
   */
  const resendGuestEmail = async (g: any) => {
    let target = g.email
    if (!target) {
      target = window.prompt(`Podaj adres email dla ${g.name}:`)?.trim()
      if (!target) return
    }
    setResendingGuestId(g.id)
    try {
      const res = await buildingAdminApi.post(
        `/building-admin/buildings/${id}/guests/${g.id}/resend-email`,
        { email: target },
      )
      if (res.data?.sent) {
        alert(`✓ Email wysłany na ${res.data.email}`)
        await loadGuests()
      } else {
        alert(`⚠ Nie udało się wysłać emaila na ${target}.`)
      }
    } catch (err: any) {
      alert(err?.response?.data?.message ?? 'Błąd wysyłania emaila')
    } finally {
      setResendingGuestId(null)
    }
  }

  const loadTickets = useCallback(async () => {
    try {
      const res = await buildingAdminApi.get(`/building-admin/buildings/${id}/tickets`)
      setTickets((prev) => {
        const newOpenIds = (res.data as any[]).filter((t) => t.status === 'OPEN').map((t) => t.id)
        const prevOpenIds = prev.filter((t) => t.status === 'OPEN').map((t) => t.id)
        const truly_new = newOpenIds.filter((nid: number) => !prevOpenIds.includes(nid))
        if (truly_new.length > 0 && prev.length > 0) {
          if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
            new Notification('📋 Nowe zgłoszenie', {
              body: `${truly_new.length} nowe zgłoszenie od mieszkańca`,
              icon: '/favicon.ico',
            })
          }
        }
        return res.data
      })
    } catch { /* ignore */ }
  }, [id])

  // Poll for new tickets every 30s
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
    const interval = setInterval(() => { loadTickets() }, 30000)
    return () => clearInterval(interval)
  }, [loadTickets])

  const load = useCallback(async () => {
    try {
      const [bRes, uRes, rRes, utRes] = await Promise.all([
        buildingAdminApi.get(`/building-admin/buildings/${id}`),
        buildingAdminApi.get(`/building-admin/buildings/${id}/units`),
        buildingAdminApi.get(`/building-admin/buildings/${id}/residents`),
        buildingAdminApi.get(`/building-admin/buildings/${id}/unit-types`),
      ])
      setBuilding(bRes.data)
      setUnits(uRes.data)
      setResidents(rRes.data)
      setUnitTypes(utRes.data)
    } catch {
      router.push('/building-admin/login')
    }
    loadTickets()
    loadVehicles()
    loadGuests()
  }, [id, router, loadTickets, loadVehicles, loadGuests])

  useEffect(() => { load() }, [load])

  if (!building) return <p className="text-gray-400">Ładowanie...</p>

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleAddUnit = async (e: React.FormEvent) => {
    e.preventDefault()
    setUAdding(true); setUError(null)
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${id}/units`, {
        unitTypeId: +uTypeId,
        number: uNumber,
        floor: uFloor ? +uFloor : undefined,
        areaSqm: uArea ? +uArea : undefined,
        description: uDesc || undefined,
        stairwellId: uStairwellId ? +uStairwellId : undefined,
      })
      setShowAddUnit(false)
      setUTypeId(''); setUNumber(''); setUFloor(''); setUArea(''); setUDesc(''); setUStairwellId('')
      load()
    } catch (err: any) {
      setUError(err?.response?.data?.message ?? 'Błąd dodawania lokalu')
    } finally { setUAdding(false) }
  }

  const handleDeleteUnit = async (unitId: number) => {
    if (!confirm('Usunąć ten lokal?')) return
    await buildingAdminApi.delete(`/building-admin/buildings/${id}/units/${unitId}`)
    load()
  }

  const handleAddUnitType = async (e: React.FormEvent) => {
    e.preventDefault()
    setUtAdding(true); setUtError(null)
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${id}/unit-types`, {
        name: utName, icon: utIcon, isCommonArea: utIsCommonArea,
      })
      setShowAddUnitType(false)
      setUtName(''); setUtIcon('🏠'); setUtIsCommonArea(false)
      load()
    } catch (err: any) {
      setUtError(err?.response?.data?.message ?? 'Błąd dodawania typu')
    } finally { setUtAdding(false) }
  }

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault()
    setSSaving(true); setSError(null)
    try {
      await buildingAdminApi.put(`/building-admin/buildings/${id}/units/${settingsUnit.id}/settings`, {
        maxSlotMinutes: sMaxSlot ? +sMaxSlot : 60,
        openTime: sOpenTime,
        closeTime: sCloseTime,
        isPaid: sIsPaid,
        pricePerHour: sIsPaid && sPricePerHour ? +sPricePerHour : null,
      })
      setSettingsUnit(null)
      load()
    } catch (err: any) {
      setSError(err?.response?.data?.message ?? 'Błąd zapisu')
    } finally { setSSaving(false) }
  }

  const handleAddResident = async (e: React.FormEvent) => {
    e.preventDefault()
    setRAdding(true); setRError(null)
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${id}/residents`, {
        firstName: rFirst, lastName: rLast, email: rEmail, phone: rPhone || undefined,
      })
      setShowAddResident(false)
      setRFirst(''); setRLast(''); setREmail(''); setRPhone('')
      load()
    } catch (err: any) {
      setRError(err?.response?.data?.message ?? 'Błąd dodawania mieszkańca')
    } finally { setRAdding(false) }
  }

  const handleDeleteResident = async (residentId: number, name: string) => {
    if (!confirm(`Usunąć mieszkańca "${name}"?`)) return
    await buildingAdminApi.delete(`/building-admin/buildings/${id}/residents/${residentId}`)
    load()
  }

  const handleAddStairwell = async (e: React.FormEvent) => {
    e.preventDefault()
    setSwAdding(true)
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${id}/stairwells`, { name: swName })
      setShowAddSw(false); setSwName('')
      load()
    } finally { setSwAdding(false) }
  }

  const handleDeleteStairwell = async (swId: number) => {
    if (!confirm('Usunąć tę klatkę schodową?')) return
    await buildingAdminApi.delete(`/building-admin/buildings/${id}/stairwells/${swId}`)
    load()
  }

  const handleSendNotif = async (e: React.FormEvent) => {
    e.preventDefault()
    setNotifSending(true); setNotifResult(null)
    try {
      const dto: any = { title: notifTitle, body: notifBody }
      if (notifResidentId) dto.residentId = +notifResidentId
      const r = await buildingAdminApi.post(`/building-admin/buildings/${id}/notifications`, dto)
      const sent = r.data.sent ?? 1
      setNotifResult(notifResidentId ? 'Powiadomienie wysłane!' : `Wysłano do ${sent} mieszkańców`)
      setNotifTitle(''); setNotifBody(''); setNotifResidentId('')
    } catch (err: any) {
      setNotifResult('Błąd: ' + (err?.response?.data?.message ?? 'nieznany błąd'))
    } finally { setNotifSending(false) }
  }

  const handleTicketStatus = async (ticketId: number, status: string) => {
    await buildingAdminApi.patch(`/building-admin/buildings/${id}/tickets/${ticketId}/status`, { status })
    loadTickets()
  }

  const handleTicketReply = async (ticketId: number) => {
    const body = replyBody[ticketId]?.trim()
    if (!body) return
    setReplySending(ticketId)
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${id}/tickets/${ticketId}/replies`, { body })
      setReplyBody((prev) => ({ ...prev, [ticketId]: '' }))
      loadTickets()
    } finally { setReplySending(null) }
  }

  const openTicketsCount = tickets.filter((t) => t.status === 'OPEN').length

  // Aktywni goście — niewygaśnięci, do badge.
  const activeGuestsCount = guests.filter((g: any) =>
    g.status === 'ACTIVE' && new Date(g.validTo) > new Date(),
  ).length

  const TABS: { key: Tab; label: string; icon: string; badge?: number }[] = [
    { key: 'residents', label: 'Mieszkańcy', icon: '👥' },
    { key: 'units', label: 'Lokale', icon: '🏠' },
    { key: 'vehicles', label: `Pojazdy (${vehicles.length})`, icon: '🚗' },
    { key: 'guests', label: `Goście (${activeGuestsCount})`, icon: '👤' },
    { key: 'stairwells', label: 'Klatki', icon: '🏛️' },
    { key: 'notifications', label: 'Powiadomienia', icon: '🔔' },
    { key: 'tickets', label: 'Zgłoszenia', icon: '📋', badge: openTicketsCount || undefined },
    { key: 'payments', label: 'Płatności', icon: '💳' },
    { key: 'branding', label: 'Branding', icon: '🖼️' },
  ]

  return (
    <>
    <div className="max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <Link href="/building-admin/buildings" className="text-sm text-gray-400 hover:text-gray-600">
          ← Obiekty
        </Link>
        <div className="flex items-start justify-between gap-4 mt-1">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl">{({ PARKING: '🅿️', ESTATE: '🏘️', APART_HOTEL: '🏨' } as Record<string,string>)[building.objectType] ?? '🏢'}</span>
              <h1 className="text-2xl font-bold text-gray-900">{building.name}</h1>
            </div>
            <p className="text-sm text-gray-400">{building.address}</p>
          </div>
          {/* Wejście do odczytów tablic tego konkretnego obiektu. Trzymamy je
              poza tabami, żeby nie gubić kontekstu po powrocie z podstrony.
              Faza 5 — dodano linki do Punktów dostępu i Urządzeń (osobne
              strony, nie taby — zachowujemy spójność z `lpr-reads`). */}
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <Link
              href={`/building-admin/buildings/${id}/access-points`}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 whitespace-nowrap"
            >
              🔌 Punkty dostępu →
            </Link>
            <Link
              href={`/building-admin/buildings/${id}/devices`}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 whitespace-nowrap"
            >
              📡 Urządzenia →
            </Link>
            <Link
              href={`/building-admin/buildings/${id}/lpr-reads`}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 whitespace-nowrap"
            >
              📸 Odczyty tablic →
            </Link>
            <Link
              href={`/building-admin/buildings/${id}/vision`}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 whitespace-nowrap"
            >
              📹 Wizja kamer →
            </Link>
            <Link
              href={`/building-admin/buildings/${id}/knowledge`}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 whitespace-nowrap"
            >
              📚 Baza wiedzy →
            </Link>
            <Link
              href={`/building-admin/buildings/${id}/assistant`}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-200 hover:from-purple-100 hover:to-pink-100 whitespace-nowrap text-purple-700 font-medium"
            >
              ✨ Asystent AI →
            </Link>
          </div>
        </div>
      </div>

      {/* Global search */}
      <div className="mb-4 relative">
        <input
          type="text"
          value={globalSearch}
          onChange={(e) => setGlobalSearch(e.target.value)}
          placeholder="🔍 Szukaj mieszkańca, lokalu, pojazdu..."
          className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
        />
        {globalSearch && (
          <button onClick={() => setGlobalSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none">
            ×
          </button>
        )}
      </div>

      {/* Global search results */}
      {globalSearch.trim() !== '' && (() => {
        const q = globalSearch.toLowerCase()
        const resMatches = residents.filter((r) =>
          `${r.firstName} ${r.lastName}`.toLowerCase().includes(q) ||
          r.email.toLowerCase().includes(q) ||
          (r.phone ?? '').includes(q)
        )
        const unitMatches = units.filter((u) =>
          (u.number ?? '').toLowerCase().includes(q) ||
          (u.unitType?.name ?? '').toLowerCase().includes(q)
        )
        const vehicleMatches = vehicles.filter((v) =>
          v.make.toLowerCase().includes(q) ||
          (v.model ?? '').toLowerCase().includes(q) ||
          v.licensePlate.toLowerCase().includes(q) ||
          v.color.toLowerCase().includes(q) ||
          `${v.resident?.firstName ?? ''} ${v.resident?.lastName ?? ''}`.toLowerCase().includes(q)
        )
        const total = resMatches.length + unitMatches.length + vehicleMatches.length
        return (
          <div className="mb-6 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {total === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">Brak wyników dla „{globalSearch}"</div>
            ) : (
              <>
                {resMatches.length > 0 && (
                  <div>
                    <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      👥 Mieszkańcy ({resMatches.length})
                    </div>
                    {resMatches.map((r) => (
                      <button key={r.id} onClick={() => { setGlobalSearch(''); openResidentModal(r); setTab('residents') }}
                        className="w-full text-left px-4 py-3 hover:bg-blue-50 border-b border-gray-50 transition">
                        <div className="text-sm font-medium text-gray-900">{r.firstName} {r.lastName}</div>
                        <div className="text-xs text-gray-400">{r.email}{r.phone ? ` · ${r.phone}` : ''}</div>
                      </button>
                    ))}
                  </div>
                )}
                {unitMatches.length > 0 && (
                  <div>
                    <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      🏠 Lokale ({unitMatches.length})
                    </div>
                    {unitMatches.map((u) => (
                      <button key={u.id} onClick={() => { setGlobalSearch(''); openUnitModal(u); setTab('units') }}
                        className="w-full text-left px-4 py-3 hover:bg-blue-50 border-b border-gray-50 transition">
                        <div className="text-sm font-medium text-gray-900">{u.unitType?.name ?? 'Lokal'} {u.number}</div>
                        <div className="text-xs text-gray-400">Piętro {u.floor ?? '—'}</div>
                      </button>
                    ))}
                  </div>
                )}
                {vehicleMatches.length > 0 && (
                  <div>
                    <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      🚗 Pojazdy ({vehicleMatches.length})
                    </div>
                    {vehicleMatches.map((v) => (
                      <button key={v.id} onClick={() => { setGlobalSearch(''); openVehicleModal(v); setTab('vehicles') }}
                        className="w-full text-left px-4 py-3 hover:bg-blue-50 border-b border-gray-50 transition">
                        <div className="text-sm font-medium text-gray-900 font-mono uppercase">{v.licensePlate}</div>
                        <div className="text-xs text-gray-400">{v.make}{v.model ? ` ${v.model}` : ''} · {v.color}{v.resident ? ` · ${v.resident.firstName} ${v.resident.lastName}` : ''}</div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )
      })()}

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-6 gap-1">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition relative ${
              tab === t.key
                ? 'bg-white border border-b-white border-gray-200 text-blue-600 -mb-px'
                : 'text-gray-500 hover:text-gray-700'
            }`}>
            {t.icon} {t.label}
            {t.badge ? (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 text-xs font-bold bg-red-500 text-white rounded-full">
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* ── TAB: Mieszkańcy ─────────────────────────────────────────────────── */}
      {tab === 'residents' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800">👥 Mieszkańcy ({residents.length})</h2>
            {!showAddResident && (
              <button onClick={() => { setShowAddResident(true); setRError(null) }}
                className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700">
                + Dodaj
              </button>
            )}
          </div>

          {showAddResident && (
            <form onSubmit={handleAddResident}
              className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
              <h3 className="text-sm font-semibold text-blue-800">Nowy mieszkaniec</h3>
              {rError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-2">{rError}</div>}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>Imię *</label>
                  <input required value={rFirst} onChange={(e) => setRFirst(e.target.value)} className={inp} />
                </div>
                <div>
                  <label className={lbl}>Nazwisko *</label>
                  <input required value={rLast} onChange={(e) => setRLast(e.target.value)} className={inp} />
                </div>
                <div>
                  <label className={lbl}>Email *</label>
                  <input required type="email" value={rEmail} onChange={(e) => setREmail(e.target.value)} className={inp} />
                </div>
                <div>
                  <label className={lbl}>Telefon</label>
                  <input value={rPhone} onChange={(e) => setRPhone(e.target.value)} className={inp} />
                </div>
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={rAdding}
                  className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {rAdding ? 'Dodawanie...' : 'Dodaj mieszkańca'}
                </button>
                <button type="button" onClick={() => setShowAddResident(false)}
                  className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                  Anuluj
                </button>
              </div>
            </form>
          )}

          {residents.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">Brak mieszkańców</p>
          ) : (
            <div className="divide-y divide-gray-100 -mx-5">
              {residents.map((r) => {
                const resUnits = r.unitResidents?.map((ur: any) => ur.unit?.number).filter(Boolean)
                const isUploadingAvatar = avatarUploading === r.id
                return (
                  <div key={r.id} className="flex items-center px-5 py-3 hover:bg-gray-50">
                    {/* Avatar + camera upload button */}
                    <div className="relative flex-shrink-0 mr-3">
                      {r.avatarBase64 ? (
                        <img
                          src={`data:image/jpeg;base64,${r.avatarBase64}`}
                          alt=""
                          className="w-9 h-9 rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 text-sm font-semibold">
                          {r.firstName?.[0]}{r.lastName?.[0]}
                        </div>
                      )}
                      <label
                        title="Zmień zdjęcie"
                        className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-blue-600 rounded-full flex items-center justify-center cursor-pointer hover:bg-blue-700"
                        style={{ pointerEvents: isUploadingAvatar ? 'none' : 'auto' }}
                      >
                        {isUploadingAvatar ? (
                          <span className="text-white" style={{ fontSize: 8 }}>...</span>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="white" className="w-2.5 h-2.5">
                            <path fillRule="evenodd" d="M1 8a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 018.07 3h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0016.07 6H17a2 2 0 012 2v7a2 2 0 01-2 2H3a2 2 0 01-2-2V8zm13.5 3a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM10 14a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
                          </svg>
                        )}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          disabled={isUploadingAvatar}
                          onChange={(e) => {
                            const file = e.target.files?.[0]
                            if (file) handleResidentAvatarUpload(r.id, file)
                            e.target.value = ''
                          }}
                        />
                      </label>
                    </div>
                    {/* Resident info — clickable */}
                    <button onClick={() => openResidentModal(r)} className="flex-1 text-left min-w-0">
                      <p className="text-sm font-medium text-gray-900">{r.firstName} {r.lastName}</p>
                      <p className="text-xs text-gray-400">{r.email}{r.phone ? ` · ${r.phone}` : ''}</p>
                      {resUnits?.length > 0 && (
                        <p className="text-xs text-blue-600 mt-0.5">🏠 {resUnits.join(', ')}</p>
                      )}
                    </button>
                    <button onClick={() => openResidentModal(r)} className="text-xs text-gray-400 pl-2">→</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: Lokale ──────────────────────────────────────────────────────── */}
      {tab === 'units' && (() => {
        const nonCommon = units.filter((u) => !u.unitType?.isCommonArea)
        const commonUnits = units.filter((u) => u.unitType?.isCommonArea)
        const selectedType = unitTypes.find((ut: any) => String(ut.id) === uTypeId)
        const isCommonAreaType = selectedType?.isCommonArea ?? false
        const garageKw = ['garaż', 'garage', 'miejsce parkingowe']
        const storageKw = ['komórka', 'komórki', 'piwnica', 'schowek', 'magazyn']
        const isGarage  = (u: any) => garageKw.some(k => u.unitType?.name?.toLowerCase().includes(k))
        const isStorage = (u: any) => storageKw.some(k => u.unitType?.name?.toLowerCase().includes(k))
        const apartments = nonCommon.filter(u => !isGarage(u) && !isStorage(u))
        const garages    = nonCommon.filter(isGarage)
        const storage    = nonCommon.filter(isStorage)

        const UnitRow = ({ u }: { u: any }) => (
          <button key={u.id} onClick={() => openUnitModal(u)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 text-left cursor-pointer transition">
            <div>
              <p className="text-sm font-medium text-gray-900">{u.unitType?.name} {u.number}</p>
              <p className="text-xs text-gray-400">
                {u.floor !== null ? `Piętro ${u.floor}` : ''}
                {u.areaSqm ? ` · ${u.areaSqm} m²` : ''}
                {u.stairwell ? ` · ${u.stairwell.name}` : ''}
              </p>
            </div>
            <span className="text-xs text-gray-400">→</span>
          </button>
        )

        const SectionBlock = ({ icon, label, color, count, empty, children }: {
          icon: string; label: string; color: string; count: number; empty: string; children?: React.ReactNode
        }) => (
          <div>
            <div className="flex items-center gap-2 px-1 mb-2">
              <span className="text-sm font-semibold text-gray-700">{icon} {label}</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${color}`}>{count}</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
              {count === 0
                ? <p className="px-5 py-4 text-sm text-gray-400 text-center">{empty}</p>
                : children}
            </div>
          </div>
        )

        return (
          <div className="space-y-6">
            {/* Typy lokali */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-gray-800">📋 Typy lokali ({unitTypes.length})</h2>
                {!showAddUnitType && (
                  <button onClick={() => { setShowAddUnitType(true); setUtError(null) }}
                    className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ Nowy typ</button>
                )}
              </div>
              <div className="flex flex-wrap gap-2 mb-2">
                {unitTypes.map((ut: any) => (
                  <span key={ut.id}
                    className={`text-xs px-2 py-1 rounded-full border ${
                      ut.isSystem ? 'bg-gray-100 text-gray-500 border-gray-200' :
                      ut.isCommonArea ? 'bg-purple-50 text-purple-700 border-purple-200' :
                      'bg-blue-50 text-blue-700 border-blue-200'
                    }`}>
                    {unitIconEmoji(ut.icon)} {ut.name}
                    {ut.isCommonArea && <span className="ml-1 text-purple-400">·część wspólna</span>}
                  </span>
                ))}
              </div>
              {showAddUnitType && (
                <form onSubmit={handleAddUnitType} className="mt-3 p-3 bg-purple-50 border border-purple-200 rounded-lg space-y-2">
                  <h3 className="text-sm font-semibold text-purple-800">Nowy typ lokalu</h3>
                  {utError && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded p-2">{utError}</div>}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={lbl}>Nazwa *</label>
                      <input required value={utName} onChange={(e) => setUtName(e.target.value)} placeholder="np. Sauna" className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Ikona (emoji)</label>
                      <input value={utIcon} onChange={(e) => setUtIcon(e.target.value)} className={inp} />
                    </div>
                  </div>
                  <button type="button" onClick={() => setUtIsCommonArea(!utIsCommonArea)}
                    className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border transition ${
                      utIsCommonArea ? 'bg-purple-100 border-purple-300 text-purple-700' : 'bg-white border-gray-200 text-gray-500'
                    }`}>
                    <span className={`w-4 h-4 rounded-full border-2 ${utIsCommonArea ? 'bg-purple-500 border-purple-500' : 'border-gray-300'}`} />
                    🏛️ Część wspólna (do rezerwacji)
                  </button>
                  <div className="flex gap-2">
                    <button type="submit" disabled={utAdding}
                      className="flex-1 bg-purple-600 text-white text-sm py-1.5 rounded-lg hover:bg-purple-700 disabled:opacity-50">
                      {utAdding ? 'Dodawanie...' : 'Dodaj typ'}
                    </button>
                    <button type="button" onClick={() => setShowAddUnitType(false)}
                      className="flex-1 border border-gray-300 text-gray-700 text-sm py-1.5 rounded-lg hover:bg-gray-50">
                      Anuluj
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Dodaj lokal — formularz */}
            {showAddUnit && (
              <form onSubmit={handleAddUnit}
                className="p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
                <h3 className="text-sm font-semibold text-blue-800">Nowy lokal</h3>
                {uError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-2">{uError}</div>}
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className={lbl}>Typ lokalu *</label>
                    <select required value={uTypeId} onChange={(e) => setUTypeId(e.target.value)} className={inp}>
                      <option value="">— Wybierz —</option>
                      {unitTypes.map((ut: any) => (
                        <option key={ut.id} value={ut.id}>
                          {unitIconEmoji(ut.icon)} {ut.name}{ut.isCommonArea ? ' (część wspólna)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Numer / nazwa *</label>
                    <input required value={uNumber} onChange={(e) => setUNumber(e.target.value)}
                      placeholder="np. 14, Sauna A" className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Piętro</label>
                    <input type="number" value={uFloor} onChange={(e) => setUFloor(e.target.value)} className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Powierzchnia (m²)</label>
                    <input type="number" step="0.01" value={uArea} onChange={(e) => setUArea(e.target.value)} className={inp} />
                  </div>
                  {!isCommonAreaType && (
                    <div>
                      <label className={lbl}>Klatka schodowa</label>
                      <select value={uStairwellId} onChange={(e) => setUStairwellId(e.target.value)} className={inp}>
                        <option value="">— Brak —</option>
                        {building.stairwells?.map((sw: any) => (
                          <option key={sw.id} value={sw.id}>{sw.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button type="submit" disabled={uAdding}
                    className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                    {uAdding ? 'Dodawanie...' : `Dodaj ${isCommonAreaType ? 'część wspólną' : 'lokal'}`}
                  </button>
                  <button type="button" onClick={() => setShowAddUnit(false)}
                    className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                    Anuluj
                  </button>
                </div>
              </form>
            )}

            {/* 1. Lokale mieszkalne */}
            <div>
              <div className="flex items-center gap-2 px-1 mb-2">
                <span className="text-sm font-semibold text-gray-700">🏠 Lokale mieszkalne</span>
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{apartments.length}</span>
                <div className="flex-1 h-px bg-gray-200" />
                {!showAddUnit && (
                  <button onClick={() => { setShowAddUnit(true); setUError(null) }}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ Dodaj</button>
                )}
              </div>
              <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
                {apartments.length === 0
                  ? <p className="px-5 py-4 text-sm text-gray-400 text-center">Brak lokali mieszkalnych</p>
                  : apartments.map((u) => <UnitRow key={u.id} u={u} />)}
              </div>
            </div>

            {/* 2. Garaże */}
            <SectionBlock icon="🚗" label="Garaże / miejsca parkingowe" color="bg-slate-100 text-slate-600" count={garages.length} empty="Brak garaży">
              {garages.map((u) => <UnitRow key={u.id} u={u} />)}
            </SectionBlock>

            {/* 3. Komórki lokatorskie */}
            <SectionBlock icon="📦" label="Komórki lokatorskie" color="bg-amber-100 text-amber-700" count={storage.length} empty="Brak komórek lokatorskich">
              {storage.map((u) => <UnitRow key={u.id} u={u} />)}
            </SectionBlock>

            {/* 4. Części wspólne */}
            <div>
              <div className="flex items-center gap-2 px-1 mb-2">
                <span className="text-sm font-semibold text-gray-700">🏛️ Części wspólne</span>
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">{commonUnits.length}</span>
                <div className="flex-1 h-px bg-gray-200" />
                {!showAddUnit && (
                  <button onClick={() => {
                    const firstCa = unitTypes.find((ut: any) => ut.isCommonArea)
                    if (firstCa) setUTypeId(String(firstCa.id))
                    setShowAddUnit(true); setUError(null)
                  }}
                    className="text-xs text-purple-600 hover:text-purple-800 font-medium">
                    + Dodaj
                  </button>
                )}
              </div>
              <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
                {commonUnits.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-gray-400 text-center">
                    Brak. Utwórz typ z opcją &quot;Część wspólna&quot; i dodaj powyżej.
                  </p>
                ) : commonUnits.map((u) => {
                  const s = u.commonAreaSettings
                  return (
                    <div key={u.id} className="px-5 py-3 flex items-center justify-between hover:bg-gray-50">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{u.unitType?.name} {u.number}</p>
                        {s ? (
                          <p className="text-xs text-gray-400">
                            {s.maxSlotMinutes} min · {s.openTime}–{s.closeTime}
                            {s.isPaid ? ` · ${s.pricePerHour} zł/h` : ' · bezpłatna'}
                          </p>
                        ) : (
                          <p className="text-xs text-amber-500">⚠️ Brak ustawień rezerwacji</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => openSettings(u)}
                          className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 rounded hover:bg-blue-50 transition">
                          ⚙️ Ustawienia
                        </button>
                        <button onClick={() => handleDeleteUnit(u.id)}
                          className="text-xs text-gray-400 hover:text-red-600">🗑️</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Settings modal inline */}
            {settingsUnit && (
              <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
                onClick={(e) => { if (e.target === e.currentTarget) setSettingsUnit(null) }}>
                <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
                  <h3 className="text-lg font-bold text-gray-900 mb-1">⚙️ Ustawienia rezerwacji</h3>
                  <p className="text-sm text-gray-500 mb-4">{settingsUnit.unitType?.name} {settingsUnit.number}</p>
                  <form onSubmit={handleSaveSettings} className="space-y-3">
                    {sError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-2">{sError}</div>}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={lbl}>Maks. czas (min)</label>
                        <input type="number" min="15" step="15" value={sMaxSlot} onChange={(e) => setSMaxSlot(e.target.value)} className={inp} />
                      </div>
                      <div />
                      <div>
                        <label className={lbl}>Godziny otwarcia</label>
                        <input type="time" value={sOpenTime} onChange={(e) => setSOpenTime(e.target.value)} className={inp} />
                      </div>
                      <div>
                        <label className={lbl}>Godziny zamknięcia</label>
                        <input type="time" value={sCloseTime} onChange={(e) => setSCloseTime(e.target.value)} className={inp} />
                      </div>
                    </div>
                    <button type="button" onClick={() => setSIsPaid(!sIsPaid)}
                      className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border transition ${
                        sIsPaid ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-200 text-gray-500'
                      }`}>
                      <span className={`w-4 h-4 rounded-full border-2 ${sIsPaid ? 'bg-blue-500 border-blue-500' : 'border-gray-300'}`} />
                      Płatna rezerwacja
                    </button>
                    {sIsPaid && (
                      <div>
                        <label className={lbl}>Cena za godzinę (zł)</label>
                        <input type="number" min="0" step="0.5" value={sPricePerHour} onChange={(e) => setSPricePerHour(e.target.value)}
                          placeholder="np. 50" className={inp} />
                      </div>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button type="submit" disabled={sSaving}
                        className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                        {sSaving ? 'Zapisywanie...' : 'Zapisz ustawienia'}
                      </button>
                      <button type="button" onClick={() => setSettingsUnit(null)}
                        className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                        Anuluj
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── TAB: Pojazdy ─────────────────────────────────────────────────────── */}
      {tab === 'vehicles' && (
        <>
        {/* Resync wszystkich APPROVED do Edge — po zmianach struktury PLATE_UPSERT
            (Faza C1, 2026-05-15) z kind/tags/unitLabel. Jeden klik wysyła
            pełen payload dla każdego zatwierdzonego pojazdu. */}
        <div className="mb-3 flex items-center justify-end">
          <button
            onClick={async () => {
              if (!confirm('Wysłać wszystkie zatwierdzone pojazdy do Edge (resync whitelist)?')) return
              try {
                const res = await buildingAdminApi.post<{ count: number }>(
                  `/building-admin/buildings/${id}/vehicles/resync-to-edge`,
                  {},
                )
                alert(`✓ Wysłano ${res.data.count} pojazdów do Edge.`)
              } catch (err: any) {
                alert(`✗ Błąd: ${err?.response?.data?.message ?? err?.message}`)
              }
            }}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1.5"
            title="Wysyła wszystkie APPROVED pojazdy do Edge whitelist z aktualnymi tagami i kategoriami"
          >
            🔄 Resync do Edge
          </button>
        </div>
        <VehiclesTab
          vehicles={vehicles}
          residents={residents}
          showAddVehicle={showAddVehicle}
          setShowAddVehicle={setShowAddVehicle}
          vResidentId={vResidentId} setVResidentId={setVResidentId}
          vMake={vMake} setVMake={setVMake}
          vModel={vModel} setVModel={setVModel}
          vColor={vColor} setVColor={setVColor}
          vPlate={vPlate} setVPlate={setVPlate}
          vAdding={vAdding} vError={vError}
          onSelect={(v) => openVehicleModal(v)}
          onAdd={async (e) => {
            e.preventDefault()
            setVAdding(true); setVError(null)
            try {
              await buildingAdminApi.post(`/building-admin/buildings/${id}/vehicles`, {
                residentId: +vResidentId, make: vMake, model: vModel || undefined, color: vColor, licensePlate: vPlate,
              })
              setShowAddVehicle(false)
              setVResidentId(''); setVMake(''); setVModel(''); setVColor(''); setVPlate('')
              loadVehicles()
            } catch (err: any) {
              setVError(err?.response?.data?.message ?? 'Błąd dodawania pojazdu')
            } finally { setVAdding(false) }
          }}
          onDelete={async (vehicleId) => {
            if (!confirm('Usunąć ten pojazd?')) return
            await buildingAdminApi.delete(`/building-admin/buildings/${id}/vehicles/${vehicleId}`)
            loadVehicles()
          }}
          onAction={async (vehicleId, action, reason) => {
            // Faza 1 bety Villa Natura — approve/reject/block/unblock.
            // Po PATCH-u przeładowujemy listę żeby pokazać nowy status + zniknął
            // banner „X do zatwierdzenia" jeśli to był ostatni PENDING.
            try {
              await buildingAdminApi.patch(
                `/building-admin/buildings/${id}/vehicles/${vehicleId}/status`,
                { action, reason },
              )
              loadVehicles()
            } catch (err: any) {
              alert(err?.response?.data?.message ?? 'Nie udało się zmienić statusu pojazdu')
            }
          }}
          canEdit={true}
        />
        </>
      )}

      {/* ── TAB: Goście ─────────────────────────────────────────────────────── */}
      {/* Faza 2 bety Villa Natura — admin może zaprosić gościa „za" mieszkańca,
          edytować dane (np. zmienić tablicę, przedłużyć pobyt) i anulować. */}
      {tab === 'guests' && (() => {
        // Tab pokazuje TYLKO aktywnych — wygasłe/anulowane są w „Historii zdarzeń".
        // Filter robimy w renderze (nie zmieniamy `guests` w state) żeby
        // `loadGuests()` nadal trzymało pełen zbiór dla badge-a `activeGuestsCount`
        // i ewentualnych przyszłych użyć.
        const now = Date.now()
        const activeGuests = guests.filter((g: any) =>
          g.status === 'ACTIVE' && new Date(g.validTo).getTime() > now,
        )
        return (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800">👤 Goście aktywni ({activeGuests.length})</h2>
            <div className="flex gap-2">
              <Link href={`/building-admin/buildings/${id}/guests/history`}
                className="bg-gray-100 text-gray-700 text-sm px-3 py-1.5 rounded-lg hover:bg-gray-200 border border-gray-200">
                📋 Historia zdarzeń
              </Link>
              <button onClick={() => openGuestForm(null)}
                className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700">
                + Zaproś gościa
              </button>
            </div>
          </div>

          {showGuestForm && (
            <form onSubmit={submitGuestForm}
              className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
              <h3 className="text-sm font-semibold text-blue-800">
                {editingGuest ? `Edycja: ${editingGuest.name}` : 'Nowe zaproszenie'}
              </h3>

              {!editingGuest && (
                <div>
                  <label className={lbl}>Mieszkaniec (zaprasza) *</label>
                  <select required value={gfResidentId} onChange={(e) => setGfResidentId(e.target.value)}
                    className={inp}>
                    <option value="">— wybierz mieszkańca —</option>
                    {residents.map((r: any) => (
                      <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>Imię i nazwisko gościa *</label>
                  <input required value={gfName} onChange={(e) => setGfName(e.target.value)}
                    placeholder="np. Jan Kowalski" className={inp} />
                </div>
                <div>
                  <label className={lbl}>Telefon</label>
                  <input value={gfPhone} onChange={(e) => setGfPhone(e.target.value)}
                    placeholder="+48..." className={inp} />
                </div>
              </div>

              {!editingGuest && (
                <div>
                  <label className={lbl}>
                    Email (opcjonalnie) — gość dostanie link do portalu
                  </label>
                  <input
                    type="email"
                    value={gfEmail}
                    onChange={(e) => setGfEmail(e.target.value)}
                    placeholder="gosc@example.com"
                    className={inp}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Jeśli wpiszesz email, system od razu wyśle wiadomość z linkiem
                    do strony zaproszenia i kodem PIN.
                  </p>
                </div>
              )}

              <div>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={gfHasVehicle}
                    onChange={(e) => setGfHasVehicle(e.target.checked)} />
                  Przyjedzie samochodem
                </label>
                {gfHasVehicle && (
                  <input value={gfPlate} onChange={(e) => setGfPlate(e.target.value.toUpperCase())}
                    placeholder="Tablica rejestracyjna" className={`${inp} mt-2 font-mono uppercase`} />
                )}
                <p className="text-xs text-gray-500 mt-1">
                  {gfHasVehicle
                    ? 'Tablica trafi do listy LPR na czas pobytu.'
                    : 'Pieszy gość — wystarczy PIN do domofonu.'}
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>Ważne od *</label>
                  <input required type="datetime-local" value={gfValidFrom}
                    onChange={(e) => setGfValidFrom(e.target.value)} className={inp} />
                </div>
                <div>
                  <label className={lbl}>Ważne do *</label>
                  <input required type="datetime-local" value={gfValidTo}
                    onChange={(e) => setGfValidTo(e.target.value)} className={inp} />
                </div>
              </div>

              {gfError && <p className="text-xs text-red-600">{gfError}</p>}

              <div className="flex gap-2">
                <button type="submit" disabled={gfSaving}
                  className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {gfSaving ? 'Zapisywanie...' : editingGuest ? 'Zapisz zmiany' : 'Zaproś gościa'}
                </button>
                <button type="button" onClick={closeGuestForm}
                  className="px-4 bg-gray-200 text-sm rounded-lg hover:bg-gray-300">
                  Anuluj
                </button>
              </div>
            </form>
          )}

          {activeGuests.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">
              Brak aktywnych gości. Wygasłe i anulowane są w „Historii zdarzeń".
            </p>
          ) : (
            <div className="overflow-x-auto -mx-5">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-5 py-2">Gość</th>
                    <th className="text-left px-3 py-2">PIN</th>
                    <th className="text-left px-3 py-2">Tablica</th>
                    <th className="text-left px-3 py-2">Zaprosił</th>
                    <th className="text-left px-3 py-2">Od</th>
                    <th className="text-left px-3 py-2">Do</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-right px-5 py-2">Akcje</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {activeGuests.map((g: any) => {
                    const isExpiredByDate = new Date(g.validTo) <= new Date()
                    const effectiveStatus =
                      g.status === 'ACTIVE' && isExpiredByDate ? 'EXPIRED' : g.status
                    const isActive = g.status === 'ACTIVE' && !isExpiredByDate
                    const statusLabel: Record<string, string> = {
                      ACTIVE: 'Aktywne', EXPIRED: 'Wygasło', CANCELLED: 'Anulowane',
                    }
                    const statusColor: Record<string, string> = {
                      ACTIVE: 'bg-green-100 text-green-700',
                      EXPIRED: 'bg-orange-100 text-orange-700',
                      CANCELLED: 'bg-red-100 text-red-700',
                    }
                    const fmt = (d: string) =>
                      new Date(d).toLocaleString('pl-PL', {
                        day: '2-digit', month: '2-digit', year: '2-digit',
                        hour: '2-digit', minute: '2-digit',
                      })
                    return (
                      <tr key={g.id} className="hover:bg-gray-50">
                        <td className="px-5 py-2">
                          <div className="font-medium text-gray-900">{g.name}</div>
                          {g.phone && <div className="text-xs text-gray-400">{g.phone}</div>}
                        </td>
                        <td className="px-3 py-2 font-mono font-bold text-blue-600">{g.pin}</td>
                        <td className="px-3 py-2 font-mono text-xs uppercase">
                          {g.vehiclePlate || <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-600">
                          {g.resident ? `${g.resident.firstName} ${g.resident.lastName}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500">{fmt(g.validFrom)}</td>
                        <td className="px-3 py-2 text-xs text-gray-500">{fmt(g.validTo)}</td>
                        <td className="px-3 py-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor[effectiveStatus] ?? 'bg-gray-100 text-gray-700'}`}>
                            {statusLabel[effectiveStatus] ?? effectiveStatus}
                          </span>
                        </td>
                        <td className="px-5 py-2 text-right">
                          {isActive ? (
                            <div className="inline-flex gap-2 text-xs">
                              <button onClick={() => openGuestForm(g)}
                                className="text-blue-600 hover:underline">Edytuj</button>
                              <button
                                disabled={resendingGuestId === g.id || !g.urlToken}
                                onClick={() => resendGuestEmail(g)}
                                title={g.email ? `Wyślij ponownie na ${g.email}` : 'Wprowadź email i wyślij link do portalu'}
                                className="text-emerald-600 hover:underline disabled:opacity-50">
                                {resendingGuestId === g.id
                                  ? '...'
                                  : g.emailSentAt ? '↻ Email' : '✉ Wyślij email'}
                              </button>
                              <button
                                disabled={cancellingGuestId === g.id}
                                onClick={() => cancelGuestById(g.id)}
                                className="text-red-600 hover:underline disabled:opacity-50">
                                {cancellingGuestId === g.id ? '...' : 'Anuluj'}
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )
      })()}

      {/* ── TAB: Klatki ──────────────────────────────────────────────────────── */}
      {tab === 'stairwells' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800">🏛️ Klatki schodowe ({building.stairwells?.length ?? 0})</h2>
            {!showAddSw && (
              <button onClick={() => setShowAddSw(true)}
                className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700">
                + Dodaj
              </button>
            )}
          </div>

          {showAddSw && (
            <form onSubmit={handleAddStairwell}
              className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
              <h3 className="text-sm font-semibold text-blue-800">Nowa klatka schodowa</h3>
              <div>
                <label className={lbl}>Nazwa klatki *</label>
                <input required value={swName} onChange={(e) => setSwName(e.target.value)}
                  placeholder="np. Klatka A, Klatka 1" className={inp} />
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={swAdding}
                  className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {swAdding ? 'Dodawanie...' : 'Dodaj klatkę'}
                </button>
                <button type="button" onClick={() => setShowAddSw(false)}
                  className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                  Anuluj
                </button>
              </div>
            </form>
          )}

          {(building.stairwells?.length ?? 0) === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">Brak klatek schodowych</p>
          ) : (
            <div className="divide-y divide-gray-100 -mx-5">
              {building.stairwells.map((sw: any) => (
                <div key={sw.id} className="px-5 py-3 flex items-center justify-between hover:bg-gray-50">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">🏛️</span>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{sw.name}</p>
                      {sw.intercom ? (
                        <p className="text-xs text-green-600">📟 Domofon: {sw.intercom.model ?? 'Akuvox'}</p>
                      ) : (
                        <p className="text-xs text-gray-400">📟 Brak konfiguracji domofonu</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link href={`/building-admin/buildings/${id}/stairwells/${sw.id}`}
                      className="text-xs text-blue-600 hover:underline">
                      Szczegóły
                    </Link>
                    <button onClick={() => handleDeleteStairwell(sw.id)}
                      className="text-xs text-gray-400 hover:text-red-600">🗑️</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: Powiadomienia ───────────────────────────────────────────────── */}
      {tab === 'notifications' && (
        <div className="space-y-6">
          {/* Formularz wysyłki powiadomienia */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 max-w-lg">
            <h2 className="font-semibold text-gray-800 mb-4">🔔 Wyślij powiadomienie</h2>
            <form onSubmit={handleSendNotif} className="space-y-3">
              {notifResult && (
                <div className={`text-sm rounded-lg p-3 border ${
                  notifResult.startsWith('Błąd')
                    ? 'bg-red-50 border-red-200 text-red-700'
                    : 'bg-green-50 border-green-200 text-green-700'
                }`}>
                  {notifResult}
                </div>
              )}
              <div>
                <label className={lbl}>Tytuł *</label>
                <input required value={notifTitle} onChange={(e) => setNotifTitle(e.target.value)}
                  placeholder="Temat powiadomienia" className={inp} />
              </div>
              <div>
                <label className={lbl}>Treść *</label>
                <textarea required value={notifBody} onChange={(e) => setNotifBody(e.target.value)}
                  placeholder="Treść wiadomości..." rows={4}
                  className={`${inp} resize-none`} />
              </div>
              <div>
                <label className={lbl}>Odbiorca (opcjonalnie — domyślnie: wszyscy)</label>
                <select value={notifResidentId} onChange={(e) => setNotifResidentId(e.target.value)} className={inp}>
                  <option value="">— Wszyscy mieszkańcy —</option>
                  {residents.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.firstName} {r.lastName} ({r.email})
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" disabled={notifSending}
                className="w-full bg-blue-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {notifSending ? 'Wysyłanie...' : '🔔 Wyślij powiadomienie'}
              </button>
            </form>
          </div>

        </div>
      )}

      {/* ── TAB: Zgłoszenia ─────────────────────────────────────────────────── */}
      {tab === 'tickets' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="font-semibold text-gray-800">
              📋 Zgłoszenia od mieszkańców
              {openTicketsCount > 0 && (
                <span className="ml-2 text-xs font-semibold bg-red-100 text-red-600 border border-red-200 px-2 py-0.5 rounded-full">
                  {openTicketsCount} otwarte
                </span>
              )}
            </h2>
            <div className="flex gap-1">
              {(['ALL', 'OPEN', 'IN_PROGRESS', 'DONE'] as const).map((f) => (
                <button key={f} onClick={() => setTicketFilter(f)}
                  className={`text-xs px-3 py-1 rounded-full border transition ${
                    ticketFilter === f
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                  }`}>
                  {f === 'ALL' ? 'Wszystkie' : f === 'OPEN' ? 'Otwarte' : f === 'IN_PROGRESS' ? 'W toku' : 'Zakończone'}
                </button>
              ))}
            </div>
          </div>

          {(() => {
            const filtered = ticketFilter === 'ALL' ? tickets : tickets.filter((t) => t.status === ticketFilter)
            if (filtered.length === 0) return (
              <p className="text-sm text-gray-400 text-center py-8">
                {ticketFilter === 'ALL' ? 'Brak zgłoszeń' : 'Brak zgłoszeń w tej kategorii'}
              </p>
            )
            const CATEGORY_LABEL: Record<string, string> = {
              ISSUE: '🔧 Usterka', FEEDBACK: '💬 Uwaga', QUESTION: '❓ Pytanie', OTHER: '📌 Inne',
            }
            const STATUS_CFG: Record<string, { label: string; cls: string }> = {
              OPEN:        { label: 'Otwarte',    cls: 'bg-red-50 text-red-600 border-red-200' },
              IN_PROGRESS: { label: 'W toku',     cls: 'bg-amber-50 text-amber-700 border-amber-200' },
              DONE:        { label: 'Zakończone', cls: 'bg-green-50 text-green-700 border-green-200' },
            }
            return (
              <div className="divide-y divide-gray-100 -mx-5">
                {filtered.map((ticket) => {
                  const isExpanded = expandedTicket === ticket.id
                  const st = STATUS_CFG[ticket.status] ?? STATUS_CFG['OPEN']
                  return (
                    <div key={ticket.id} className="px-5">
                      <div
                        className="py-3 flex items-start justify-between gap-3 cursor-pointer hover:bg-gray-50 -mx-5 px-5"
                        onClick={() => setExpandedTicket(isExpanded ? null : ticket.id)}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-400">{CATEGORY_LABEL[ticket.category] ?? '📌 Inne'}</span>
                            <p className="text-sm font-medium text-gray-900">{ticket.title}</p>
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {ticket.resident?.firstName} {ticket.resident?.lastName}
                            {' · '}
                            {new Date(ticket.createdAt).toLocaleDateString('pl-PL', {
                              day: '2-digit', month: '2-digit', year: 'numeric',
                              hour: '2-digit', minute: '2-digit',
                            })}
                            {ticket.replies?.length > 0 && ` · 💬 ${ticket.replies.length}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`text-xs border px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                          <span className="text-gray-300">{isExpanded ? '▲' : '▼'}</span>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="pb-4 space-y-3">
                          <div className="bg-gray-50 rounded-lg p-3">
                            <p className="text-sm text-gray-700 whitespace-pre-wrap">{ticket.body}</p>
                          </div>

                          {ticket.photo && (
                            <img
                              src={ticket.photo}
                              alt="Załączone zdjęcie"
                              className="max-h-64 rounded-lg border border-gray-200 object-contain"
                            />
                          )}

                          {ticket.replies?.length > 0 && (
                            <div className="space-y-2">
                              {ticket.replies.map((reply: any) => (
                                <div key={reply.id}
                                  className={`rounded-lg p-3 text-sm ${
                                    reply.authorType === 'ADMIN'
                                      ? 'bg-blue-50 border border-blue-100 ml-4'
                                      : 'bg-white border border-gray-200'
                                  }`}>
                                  <p className="text-xs font-medium mb-1 text-gray-500">
                                    {reply.authorType === 'ADMIN' ? '🏢 Administrator' : `👤 ${ticket.resident?.firstName} ${ticket.resident?.lastName}`}
                                    {' · '}
                                    {new Date(reply.createdAt).toLocaleDateString('pl-PL', {
                                      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                                    })}
                                  </p>
                                  <p className="text-gray-700 whitespace-pre-wrap">{reply.body}</p>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="space-y-2">
                            <textarea
                              value={replyBody[ticket.id] ?? ''}
                              onChange={(e) => setReplyBody((prev) => ({ ...prev, [ticket.id]: e.target.value }))}
                              placeholder="Napisz odpowiedź do mieszkańca..."
                              rows={2}
                              className={`${inp} resize-none`}
                            />
                            <div className="flex gap-2 flex-wrap">
                              <button
                                onClick={() => handleTicketReply(ticket.id)}
                                disabled={replySending === ticket.id || !replyBody[ticket.id]?.trim()}
                                className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                                {replySending === ticket.id ? 'Wysyłanie...' : '💬 Odpowiedz'}
                              </button>
                              <select
                                value={ticket.status}
                                onChange={(e) => handleTicketStatus(ticket.id, e.target.value)}
                                className="text-xs border border-gray-300 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <option value="OPEN">Otwarte</option>
                                <option value="IN_PROGRESS">W toku</option>
                                <option value="DONE">Zakończone</option>
                              </select>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>
      )}
    </div>

      {tab === 'payments' && (
        <PaymentsTab buildingId={String(id)} api={buildingAdminApi} />
      )}

      {tab === 'branding' && (
        <BrandingTab
          building={building}
          uploading={brandingUploading}
          onUpload={async (field, base64) => {
            setBrandingUploading(field === 'logoBase64' ? 'logo' : 'bg')
            try {
              await buildingAdminApi.patch(`/building-admin/buildings/${id}/branding`, { [field]: base64 })
              const res = await buildingAdminApi.get(`/building-admin/buildings/${id}`)
              setBuilding(res.data)
            } finally { setBrandingUploading(null) }
          }}
          onRemove={async (field) => {
            await buildingAdminApi.patch(`/building-admin/buildings/${id}/branding`, { [field]: null })
            const res = await buildingAdminApi.get(`/building-admin/buildings/${id}`)
            setBuilding(res.data)
          }}
        />
      )}

      {/* ── Resident Detail Modal ──────────────────────────────────────────────── */}
      {selResident && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">
                👤 {selResident.firstName} {selResident.lastName}
              </h2>
              <button onClick={() => { setSelResident(null); setReEditMode(false) }}
                className="text-gray-400 hover:text-gray-600 text-xl font-light">✕</button>
            </div>
            <div className="p-5 space-y-4">
              {!reEditMode ? (
                <>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><span className="text-gray-500">Email</span><p className="font-medium text-gray-900">{selResident.email}</p></div>
                    <div><span className="text-gray-500">Telefon</span><p className="font-medium text-gray-900">{selResident.phone || '—'}</p></div>
                  </div>
                  {/* Lokale */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 mb-2">Lokale</h3>
                    {(selResident.unitResidents ?? []).length === 0
                      ? <p className="text-xs text-gray-400">Brak przypisanych lokali</p>
                      : (selResident.unitResidents ?? []).map((ur: any) => (
                        <div key={ur.id} className="text-sm text-gray-700 py-1 border-b border-gray-50 last:border-0">
                          {ur.unit?.unitType?.name} {ur.unit?.number}{ur.unit?.floor != null ? `, p. ${ur.unit.floor}` : ''}
                        </div>
                      ))
                    }
                  </div>
                  {/* Pojazdy */}
                  <div>
                    <h3 className="text-sm font-semibold text-gray-700 mb-2">Pojazdy</h3>
                    {vehicles.filter(v => v.residentId === selResident.id).length === 0
                      ? <p className="text-xs text-gray-400">Brak pojazdów</p>
                      : vehicles.filter(v => v.residentId === selResident.id).map((v: any) => (
                        <div key={v.id} className="text-sm text-gray-700 py-1 border-b border-gray-50 last:border-0">
                          {v.make}{v.model ? ` ${v.model}` : ''} · {v.licensePlate} · {v.color}
                        </div>
                      ))
                    }
                  </div>
                  <button onClick={() => setReEditMode(true)}
                    className="w-full bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700">
                    Edytuj
                  </button>
                  {/* Ustaw / zresetuj hasło */}
                  <div className="border-t border-gray-100 pt-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Hasło do aplikacji mobilnej</p>
                    <form onSubmit={handleSetRePassword} className="space-y-2">
                      {rePwResult && (
                        <div className={`text-xs rounded-lg px-3 py-2 border ${
                          rePwResult.startsWith('Błąd') || rePwResult.startsWith('Hasła')
                            ? 'bg-red-50 border-red-200 text-red-700'
                            : 'bg-green-50 border-green-200 text-green-700'
                        }`}>{rePwResult}</div>
                      )}
                      <input
                        type="password"
                        value={rePwNew}
                        onChange={e => setRePwNew(e.target.value)}
                        placeholder="Nowe hasło (min. 6 znaków)"
                        className={inp}
                      />
                      <input
                        type="password"
                        value={rePwConfirm}
                        onChange={e => setRePwConfirm(e.target.value)}
                        placeholder="Potwierdź hasło"
                        className={inp}
                      />
                      <button type="submit" disabled={rePwSaving || !rePwNew || !rePwConfirm}
                        className="w-full bg-gray-800 text-white text-sm py-2 rounded-lg hover:bg-gray-900 disabled:opacity-50">
                        {rePwSaving ? 'Zapisywanie...' : '🔑 Ustaw / zresetuj hasło'}
                      </button>
                    </form>
                  </div>

                  {/* Wyślij wiadomość */}
                  <div className="border-t border-gray-100 pt-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Wyślij wiadomość</p>
                    <form onSubmit={handleSendReNotif} className="space-y-2">
                      {reNotifResult && (
                        <div className={`text-xs rounded-lg px-3 py-2 border ${
                          reNotifResult.startsWith('Błąd')
                            ? 'bg-red-50 border-red-200 text-red-700'
                            : 'bg-green-50 border-green-200 text-green-700'
                        }`}>{reNotifResult}</div>
                      )}
                      <input required value={reNotifTitle} onChange={e => setReNotifTitle(e.target.value)}
                        placeholder="Tytuł *" className={inp} />
                      <textarea required value={reNotifBody} onChange={e => setReNotifBody(e.target.value)}
                        placeholder="Treść wiadomości *" rows={3}
                        className={`${inp} resize-none`} />
                      <button type="submit" disabled={reNotifSending}
                        className="w-full bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                        {reNotifSending ? 'Wysyłanie...' : '🔔 Wyślij powiadomienie'}
                      </button>
                    </form>
                  </div>

                  {/* Strefa niebezpieczna */}
                  <div className="border-t border-red-100 pt-3">
                    <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-2">Strefa niebezpieczna</p>
                    <button
                      onClick={async () => {
                        const name = `${selResident.firstName} ${selResident.lastName}`
                        if (!confirm(`Usunąć mieszkańca "${name}" z budynku? Tej operacji nie można cofnąć.`)) return
                        try {
                          await buildingAdminApi.delete(`/building-admin/buildings/${id}/residents/${selResident.id}`)
                          setSelResident(null)
                          load()
                        } catch (err: any) {
                          alert(err?.response?.data?.message ?? 'Błąd usuwania mieszkańca')
                        }
                      }}
                      className="w-full border border-red-200 text-red-600 hover:bg-red-50 text-sm py-2 rounded-lg transition">
                      🗑️ Usuń mieszkańca z budynku
                    </button>
                    <p className="text-xs text-gray-400 mt-1 text-center">
                      Usunięcie jest nieodwracalne. Konto mobilne zostanie dezaktywowane.
                    </p>
                  </div>
                </>
              ) : (
                <form onSubmit={handleSaveResident} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={lbl}>Imię *</label>
                      <input required value={reFirst} onChange={e => setReFirst(e.target.value)} className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Nazwisko *</label>
                      <input required value={reLast} onChange={e => setReLast(e.target.value)} className={inp} />
                    </div>
                  </div>
                  <div>
                    <label className={lbl}>Email *</label>
                    <input required type="email" value={reEmail} onChange={e => setReEmail(e.target.value)} className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Telefon</label>
                    <input value={rePhone} onChange={e => setRePhone(e.target.value)} className={inp} />
                  </div>
                  {reErrMsg && <p className="text-xs text-red-500">{reErrMsg}</p>}
                  <div className="flex gap-2">
                    <button type="submit" disabled={reSaving}
                      className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                      {reSaving ? 'Zapisywanie...' : 'Zapisz'}
                    </button>
                    <button type="button" onClick={() => setReEditMode(false)}
                      className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                      Anuluj
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Unit Detail Modal ──────────────────────────────────────────────────── */}
      {selUnit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">
                🚪 {selUnit.unitType?.name} {selUnit.number}
              </h2>
              <button onClick={() => { setSelUnit(null); setUeEditMode(false) }}
                className="text-gray-400 hover:text-gray-600 text-xl font-light">✕</button>
            </div>
            <div className="p-5 space-y-4">
              {!ueEditMode ? (
                <>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><span className="text-gray-500">Numer</span><p className="font-medium text-gray-900">{selUnit.number}</p></div>
                    <div><span className="text-gray-500">Piętro</span><p className="font-medium text-gray-900">{selUnit.floor ?? '—'}</p></div>
                    <div><span className="text-gray-500">Typ</span><p className="font-medium text-gray-900">{selUnit.unitType?.name}</p></div>
                    <div><span className="text-gray-500">Klatka</span><p className="font-medium text-gray-900">{selUnit.stairwell?.name ?? '—'}</p></div>
                  </div>
                  {/* Mieszkańcy lokalu */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-gray-700">Właściciele / Mieszkańcy</h3>
                      {!ueShowAssignForm && (
                        <button onClick={() => { setUeShowAssignForm(true); setUeAssignError(null) }}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                          + Przypisz
                        </button>
                      )}
                    </div>

                    {/* Aktywni */}
                    {(() => {
                      const active = ueResidents.filter((ur: any) => !ur.untilDate || new Date(ur.untilDate) > new Date())
                      return active.length === 0
                        ? <p className="text-xs text-gray-400 mb-2">Brak przypisanych mieszkańców</p>
                        : (
                          <div className="divide-y divide-gray-100 mb-3 rounded-lg border border-gray-100 overflow-hidden">
                            {active.map((ur: any) => (
                              <div key={ur.id} className="flex items-center justify-between px-3 py-2 bg-white">
                                <div>
                                  <p className="text-sm font-medium text-gray-900">
                                    {ur.resident?.firstName} {ur.resident?.lastName}
                                  </p>
                                  <p className="text-xs text-gray-400">
                                    <span className={`inline-block mr-2 px-1.5 py-0.5 rounded text-xs font-medium ${
                                      ur.role === 'OWNER' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'
                                    }`}>
                                      {ur.role === 'OWNER' ? '👤 Właściciel' : '👥 Najemca'}
                                    </span>
                                    od {new Date(ur.sinceDate).toLocaleDateString('pl-PL')}
                                  </p>
                                </div>
                                <button
                                  onClick={() => handleUnassignResident(ur.id)}
                                  disabled={ueUnassigning === ur.id}
                                  title="Odepnij od lokalu"
                                  className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-40 transition ml-2">
                                  {ueUnassigning === ur.id ? '...' : '✕'}
                                </button>
                              </div>
                            ))}
                          </div>
                        )
                    })()}

                    {/* Formularz przypisania */}
                    {ueShowAssignForm && (
                      <form onSubmit={handleAssignResident}
                        className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
                        <h4 className="text-xs font-semibold text-blue-800">Przypisz mieszkańca do lokalu</h4>
                        {ueAssignError && <p className="text-xs text-red-600">{ueAssignError}</p>}
                        <select required value={ueAssignResidentId} onChange={e => setUeAssignResidentId(e.target.value)} className={inp}>
                          <option value="">— Wybierz mieszkańca —</option>
                          {residents.map((r: any) => (
                            <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
                          ))}
                        </select>
                        <div className="grid grid-cols-2 gap-2">
                          <select value={ueAssignRole} onChange={e => setUeAssignRole(e.target.value)} className={inp}>
                            <option value="OWNER">👤 Właściciel</option>
                            <option value="TENANT">👥 Najemca</option>
                          </select>
                          <input type="date" value={ueAssignDate} onChange={e => setUeAssignDate(e.target.value)}
                            placeholder="Data od" className={inp} />
                        </div>
                        <div className="flex gap-2">
                          <button type="submit" disabled={ueAssigning}
                            className="flex-1 bg-blue-600 text-white text-xs py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                            {ueAssigning ? 'Przypisywanie...' : 'Przypisz'}
                          </button>
                          <button type="button" onClick={() => setUeShowAssignForm(false)}
                            className="flex-1 border border-gray-300 text-gray-700 text-xs py-1.5 rounded-lg hover:bg-gray-50">
                            Anuluj
                          </button>
                        </div>
                      </form>
                    )}
                  </div>

                  <button onClick={() => setUeEditMode(true)}
                    className="w-full bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700">
                    ✏️ Edytuj dane lokalu
                  </button>

                  {/* Strefa niebezpieczna */}
                  <div className="border-t border-red-100 pt-3">
                    <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-2">Strefa niebezpieczna</p>
                    <button
                      onClick={async () => {
                        if (!confirm(`Usunąć lokal "${selUnit.unitType?.name} ${selUnit.number}"? Tej operacji nie można cofnąć.`)) return
                        try {
                          await buildingAdminApi.delete(`/building-admin/buildings/${id}/units/${selUnit.id}`)
                          setSelUnit(null)
                          load()
                        } catch (err: any) {
                          alert(err?.response?.data?.message ?? 'Błąd usuwania lokalu')
                        }
                      }}
                      className="w-full border border-red-200 text-red-600 hover:bg-red-50 text-sm py-2 rounded-lg transition">
                      🗑️ Usuń lokal
                    </button>
                  </div>
                </>
              ) : (
                <form onSubmit={handleSaveUnit} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={lbl}>Numer *</label>
                      <input required value={ueNumber} onChange={e => setUeNumber(e.target.value)} className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Piętro</label>
                      <input type="number" value={ueFloor} onChange={e => setUeFloor(e.target.value)} className={inp} />
                    </div>
                  </div>
                  <div>
                    <label className={lbl}>Typ lokalu *</label>
                    <select required value={ueTypeId} onChange={e => setUeTypeId(e.target.value)} className={inp}>
                      <option value="">Wybierz typ</option>
                      {unitTypes.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Klatka</label>
                    <select value={ueStairwellId} onChange={e => setUeStairwellId(e.target.value)} className={inp}>
                      <option value="">Brak</option>
                      {(building?.stairwells ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  {ueErrMsg && <p className="text-xs text-red-500">{ueErrMsg}</p>}
                  <div className="flex gap-2">
                    <button type="submit" disabled={ueSaving}
                      className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                      {ueSaving ? 'Zapisywanie...' : 'Zapisz'}
                    </button>
                    <button type="button" onClick={() => setUeEditMode(false)}
                      className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                      Anuluj
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Vehicle Detail Modal ───────────────────────────────────────────────── */}
      {selVehicle && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">
                🚗 {selVehicle.make}{selVehicle.model ? ` ${selVehicle.model}` : ''} · {selVehicle.licensePlate}
              </h2>
              <button onClick={() => { setSelVehicle(null); setVeEditMode(false) }}
                className="text-gray-400 hover:text-gray-600 text-xl font-light">✕</button>
            </div>
            <div className="p-5 space-y-4">
              {!veEditMode ? (
                <>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><span className="text-gray-500">Marka</span><p className="font-medium text-gray-900">{selVehicle.make}</p></div>
                    <div><span className="text-gray-500">Model</span><p className="font-medium text-gray-900">{selVehicle.model || '—'}</p></div>
                    <div><span className="text-gray-500">Kolor</span><p className="font-medium text-gray-900">{selVehicle.color}</p></div>
                    <div><span className="text-gray-500">Tablica</span><p className="font-medium text-gray-900">{selVehicle.licensePlate}</p></div>
                    <div className="col-span-2">
                      <span className="text-gray-500">Właściciel</span>
                      <p className="font-medium text-gray-900">
                        {selVehicle.resident
                          ? `${selVehicle.resident.firstName} ${selVehicle.resident.lastName}`
                          : '—'}
                      </p>
                    </div>
                    {/* Tagi — chip-y. Puste = "Brak tagów" placeholder, żeby
                        user wiedział że taką funkcję ma dostępną w Edycji. */}
                    <div className="col-span-2">
                      <span className="text-gray-500">Tagi</span>
                      {Array.isArray(selVehicle.tags) && selVehicle.tags.length > 0 ? (
                        <div className="mt-1">
                          <TagChips tags={selVehicle.tags} />
                        </div>
                      ) : (
                        <p className="text-sm text-gray-400 italic">brak tagów — kliknij Edytuj aby dodać</p>
                      )}
                    </div>
                  </div>
                  <button onClick={() => setVeEditMode(true)}
                    className="w-full bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700">
                    Edytuj
                  </button>
                </>
              ) : (
                <form onSubmit={handleSaveVehicle} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={lbl}>Marka *</label>
                      <input required value={veMake} onChange={e => setVeMake(e.target.value)} className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Model</label>
                      <input value={veModel} onChange={e => setVeModel(e.target.value)} className={inp} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={lbl}>Kolor *</label>
                      <input required value={veColor} onChange={e => setVeColor(e.target.value)} className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Tablica rejestracyjna *</label>
                      <input required value={vePlate} onChange={e => setVePlate(e.target.value)} className={inp} />
                    </div>
                  </div>
                  <div>
                    <label className={lbl}>Właściciel *</label>
                    <select required value={veResidentId} onChange={e => setVeResidentId(e.target.value)} className={inp}>
                      <option value="">Wybierz mieszkańca</option>
                      {residents.map((r: any) => (
                        <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Tagi</label>
                    <p className="text-[11px] text-gray-400 mb-1.5">
                      Wyszukiwarka tablic znajdzie pojazd po każdym z tagów.
                      Wpisz Enter lub przecinek aby dodać własny.
                    </p>
                    <TagPicker
                      value={veTags}
                      onChange={setVeTags}
                      apiClient={buildingAdminApi}
                      buildSuggestionsUrl={() => `/building-admin/buildings/${id}/vehicle-tags`}
                      ariaLabel="Tagi pojazdu"
                    />
                  </div>
                  {veErrMsg && <p className="text-xs text-red-500">{veErrMsg}</p>}
                  <div className="flex gap-2">
                    <button type="submit" disabled={veSaving}
                      className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                      {veSaving ? 'Zapisywanie...' : 'Zapisz'}
                    </button>
                    <button type="button" onClick={() => setVeEditMode(false)}
                      className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                      Anuluj
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const inp = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
const lbl = 'block text-xs text-gray-600 mb-1'

// Konwersja Date|ISO string do wartości akceptowanej przez <input type="datetime-local">.
// Format wymagany przez przeglądarki: `YYYY-MM-DDTHH:MM` w lokalnej strefie czasowej.
function toLocalInput(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

// ─── PAYMENTS TAB ─────────────────────────────────────────────────────────────

function PaymentsTab({ buildingId, api }: { buildingId: string; api: any }) {
  const [overview, setOverview] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUnit, setSelectedUnit] = useState<any | null>(null)
  const [unitDetail, setUnitDetail] = useState<any | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Config form
  const [cfgRent, setCfgRent] = useState('')
  const [cfgDue, setCfgDue] = useState('10')
  const [cfgOpenBal, setCfgOpenBal] = useState('0')
  const [cfgOpenDate, setCfgOpenDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [cfgSaving, setCfgSaving] = useState(false)

  // Correction form
  const [corrAmount, setCorrAmount] = useState('')
  const [corrDesc, setCorrDesc] = useState('')
  const [corrDate, setCorrDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [corrSaving, setCorrSaving] = useState(false)

  // MT940
  const [mt940Result, setMt940Result] = useState<string | null>(null)
  const [mt940Loading, setMt940Loading] = useState(false)

  // Reminder
  const [remindResult, setRemindResult] = useState<string | null>(null)

  useEffect(() => { loadOverview() }, [buildingId])

  async function loadOverview() {
    setLoading(true)
    try {
      const res = await api.get(`/building-admin/buildings/${buildingId}/payments`)
      setOverview(res.data)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  async function openUnit(unit: any) {
    setSelectedUnit(unit)
    setDetailLoading(true)
    setUnitDetail(null)
    setRemindResult(null)
    setMt940Result(null)
    try {
      const res = await api.get(`/building-admin/buildings/${buildingId}/payments/${unit.unitId}`)
      setUnitDetail(res.data)
      const cfg = res.data.config
      if (cfg) {
        setCfgRent(String(cfg.monthlyRent))
        setCfgDue(String(cfg.dueDay))
        setCfgOpenBal(String(cfg.openingBalance))
        setCfgOpenDate(cfg.openingDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10))
      } else {
        setCfgRent(''); setCfgDue('10'); setCfgOpenBal('0')
        setCfgOpenDate(new Date().toISOString().slice(0, 10))
      }
    } catch { /* ignore */ }
    finally { setDetailLoading(false) }
  }

  async function saveConfig(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedUnit) return
    setCfgSaving(true)
    try {
      await api.put(`/building-admin/buildings/${buildingId}/payments/${selectedUnit.unitId}/config`, {
        monthlyRent: parseFloat(cfgRent),
        dueDay: parseInt(cfgDue),
        openingBalance: parseFloat(cfgOpenBal),
        openingDate: cfgOpenDate,
      })
      await openUnit(selectedUnit)
    } catch { /* ignore */ }
    finally { setCfgSaving(false) }
  }

  async function addCorrection(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedUnit) return
    setCorrSaving(true)
    try {
      await api.post(`/building-admin/buildings/${buildingId}/payments/${selectedUnit.unitId}/correction`, {
        amount: parseFloat(corrAmount),
        description: corrDesc,
        date: corrDate,
      })
      setCorrAmount(''); setCorrDesc('')
      await openUnit(selectedUnit)
      await loadOverview()
    } catch { /* ignore */ }
    finally { setCorrSaving(false) }
  }

  async function handleMt940(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setMt940Loading(true); setMt940Result(null)
    try {
      const content = await file.text()
      const res = await api.post(`/building-admin/buildings/${buildingId}/payments/mt940`, { content })
      const { total, matched, unmatched } = res.data
      setMt940Result(`✅ Zaimportowano: ${matched} wpłat / ${total} transakcji (${unmatched} niedopasowanych)`)
      await loadOverview()
      if (selectedUnit) await openUnit(selectedUnit)
    } catch (err: any) {
      setMt940Result('❌ Błąd importu: ' + (err?.response?.data?.message ?? 'nieznany'))
    } finally { setMt940Loading(false) }
  }

  async function sendReminder() {
    if (!selectedUnit) return
    setRemindResult(null)
    try {
      const res = await api.post(`/building-admin/buildings/${buildingId}/payments/${selectedUnit.unitId}/remind`)
      setRemindResult(`✅ Wysłano przypomnienia do ${res.data.sent} mieszkańca/ów`)
    } catch (err: any) {
      setRemindResult('❌ ' + (err?.response?.data?.message ?? 'Błąd'))
    }
  }

  const balanceColor = (b: number) =>
    b >= 0 ? 'text-green-600' : 'text-red-500'

  const typeLabel: Record<string, string> = {
    CHARGE: 'Obciążenie', PAYMENT: 'Wpłata', CORRECTION: 'Korekta',
  }
  const typeColor: Record<string, string> = {
    CHARGE: 'bg-red-50 text-red-700', PAYMENT: 'bg-green-50 text-green-700', CORRECTION: 'bg-amber-50 text-amber-700',
  }

  if (loading) return <div className="text-center py-12 text-gray-400">Ładowanie…</div>

  return (
    <div className="flex gap-4 items-start">
      {/* ── Lista lokali ── */}
      <div className="w-72 flex-shrink-0 space-y-2">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-800">💳 Płatności</h2>
          {/* MT940 upload */}
          <label className={`cursor-pointer text-xs px-3 py-1.5 rounded-lg border border-blue-200 text-blue-700 hover:bg-blue-50 ${mt940Loading ? 'opacity-50 pointer-events-none' : ''}`}>
            {mt940Loading ? '⏳' : '📥 MT940'}
            <input type="file" accept=".sta,.mt940,.txt" className="hidden" onChange={handleMt940} />
          </label>
        </div>
        {mt940Result && (
          <div className="text-xs px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-gray-700 mb-2">
            {mt940Result}
          </div>
        )}
        {overview.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-6">Brak lokali w budynku</p>
        )}
        {overview.map(u => (
          <button key={u.unitId} onClick={() => openUnit(u)}
            className={`w-full text-left px-4 py-3 rounded-xl border transition ${
              selectedUnit?.unitId === u.unitId
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 bg-white hover:border-gray-300'
            }`}>
            <div className="flex items-center justify-between">
              <span className="font-medium text-gray-800 text-sm">Lokal {u.number}</span>
              <span className={`text-sm font-semibold ${balanceColor(u.balance)}`}>
                {u.balance >= 0 ? '+' : ''}{u.balance.toFixed(2)} PLN
              </span>
            </div>
            {u.config ? (
              <p className="text-xs text-gray-400 mt-0.5">
                Czynsz: {Number(u.config.monthlyRent).toFixed(2)} PLN · termin: {u.config.dueDay}. dnia
              </p>
            ) : (
              <p className="text-xs text-amber-500 mt-0.5">⚠️ Brak konfiguracji</p>
            )}
            {u.residents.length > 0 && (
              <p className="text-xs text-gray-400 mt-0.5 truncate">
                {u.residents.map((r: any) => `${r.firstName} ${r.lastName}`).join(', ')}
              </p>
            )}
          </button>
        ))}
      </div>

      {/* ── Szczegóły lokalu ── */}
      {selectedUnit ? (
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-800">
              Lokal {selectedUnit.number}
              {unitDetail && (
                <span className={`ml-3 text-base font-bold ${balanceColor(unitDetail.balance)}`}>
                  {unitDetail.balance >= 0 ? '+' : ''}{unitDetail.balance.toFixed(2)} PLN
                </span>
              )}
            </h3>
            <button onClick={sendReminder}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
              🔔 Wyślij przypomnienie
            </button>
          </div>
          {remindResult && <p className="text-xs text-gray-600">{remindResult}</p>}

          {detailLoading && <div className="text-center py-8 text-gray-400">Ładowanie…</div>}

          {unitDetail && !detailLoading && (
            <>
              {/* Konfiguracja czynszu */}
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">⚙️ Konfiguracja czynszu</h4>
                <form onSubmit={saveConfig} className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={lbl}>Czynsz miesięczny (PLN)</label>
                    <input className={inp} type="number" step="0.01" value={cfgRent} onChange={e => setCfgRent(e.target.value)} required placeholder="np. 1200.00" />
                  </div>
                  <div>
                    <label className={lbl}>Termin płatności (dzień miesiąca)</label>
                    <input className={inp} type="number" min="1" max="28" value={cfgDue} onChange={e => setCfgDue(e.target.value)} required />
                  </div>
                  <div>
                    <label className={lbl}>Saldo początkowe (PLN)</label>
                    <input className={inp} type="number" step="0.01" value={cfgOpenBal} onChange={e => setCfgOpenBal(e.target.value)} required />
                  </div>
                  <div>
                    <label className={lbl}>Na dzień</label>
                    <input className={inp} type="date" value={cfgOpenDate} onChange={e => setCfgOpenDate(e.target.value)} required />
                  </div>
                  <div className="col-span-2 flex justify-end">
                    <button type="submit" disabled={cfgSaving}
                      className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
                      {cfgSaving ? 'Zapisywanie…' : '💾 Zapisz konfigurację'}
                    </button>
                  </div>
                </form>
              </div>

              {/* Ręczna korekta */}
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">✏️ Ręczna korekta salda</h4>
                <form onSubmit={addCorrection} className="grid grid-cols-3 gap-3 items-end">
                  <div>
                    <label className={lbl}>Kwota (+ wpłata, − obciążenie)</label>
                    <input className={inp} type="number" step="0.01" value={corrAmount} onChange={e => setCorrAmount(e.target.value)} required placeholder="np. 500.00" />
                  </div>
                  <div>
                    <label className={lbl}>Data</label>
                    <input className={inp} type="date" value={corrDate} onChange={e => setCorrDate(e.target.value)} required />
                  </div>
                  <div>
                    <label className={lbl}>Opis</label>
                    <input className={inp} value={corrDesc} onChange={e => setCorrDesc(e.target.value)} placeholder="np. Korekta czynszu" />
                  </div>
                  <div className="col-span-3 flex justify-end">
                    <button type="submit" disabled={corrSaving}
                      className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50">
                      {corrSaving ? 'Dodawanie…' : '+ Dodaj korektę'}
                    </button>
                  </div>
                </form>
              </div>

              {/* Historia */}
              <div className="bg-white rounded-xl border border-gray-200 p-5">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">📋 Historia transakcji</h4>
                {unitDetail.entries.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6">Brak transakcji</p>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {unitDetail.entries.map((e: any) => (
                      <div key={e.id} className="flex items-center gap-3 py-2.5">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeColor[e.type]}`}>
                          {typeLabel[e.type]}
                        </span>
                        <span className="text-xs text-gray-400 flex-shrink-0">
                          {new Date(e.date).toLocaleDateString('pl-PL')}
                        </span>
                        <span className="text-sm text-gray-600 flex-1 truncate">{e.description || '—'}</span>
                        {e.source === 'mt940' && (
                          <span className="text-xs bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded">MT940</span>
                        )}
                        <span className={`text-sm font-semibold flex-shrink-0 ${e.amount >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                          {e.amount >= 0 ? '+' : ''}{e.amount.toFixed(2)} PLN
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-400 py-16">
          <div className="text-center">
            <div className="text-4xl mb-2">💳</div>
            <p>Wybierz lokal z listy</p>
          </div>
        </div>
      )}
    </div>
  )
}
