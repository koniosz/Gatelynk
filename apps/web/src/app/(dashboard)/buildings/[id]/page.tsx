'use client'
import React, { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'
import { unitIconEmoji } from '@/lib/unit-icon'

const packageLabel: Record<string, string> = {
  LOCKER: '📦 Paczkomat Pointpack',
  CONCIERGE: '🧑‍💼 Przez konsjerża',
}

// ─── Statyczne dane producentów / modeli ──────────────────────────────────────
const INTERCOM_MANUFACTURERS = ['Akuvox', 'Dnake', '2N', 'Hikvision', 'Comelit']
const INTERCOM_MODELS: Record<string, string[]> = {
  Akuvox:    ['E16', 'E18', 'R29C'],
  Dnake:     ['S617', 'S615'],
  '2N':      ['IP Style', 'IP Verso'],
  Hikvision: ['DS-KD9214'],
  Comelit:   ['IX8090'],
}
const LPR_MANUFACTURERS = ['Hikvision', 'Dahua', 'Axis', 'Bosch', 'Inny']
const LPR_MODELS: Record<string, string[]> = {
  Hikvision: ['DS-2CD4A26FWD', 'DS-2CD4A16FWD', 'iDS-2CD7046G0'],
  Dahua: ['ITC237-PW1B', 'ITC413-PW4D', 'ITC413-PW1B'],
  Axis: ['P1448-LE', 'Q6100-E'],
  Bosch: ['FLEXIDOME 5100i', 'AUTODOME 7000i'],
  Inny: [],
}

export default function BuildingPage() {
  const { id } = useParams()
  const router = useRouter()
  const [building, setBuilding] = useState<any>(null)
  const [units, setUnits] = useState<any[]>([])
  const [unitTypes, setUnitTypes] = useState<any[]>([])
  const [residents, setResidents] = useState<any[]>([])
  const [tab, setTab] = useState<'units' | 'residents' | 'info' | 'team' | 'vehicles' | 'branding' | 'edge'>('units')
  // Branding
  const [brandingUploading, setBrandingUploading] = useState<'logo' | 'bg' | null>(null)

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
  const [selectedResident, setSelectedResident] = useState<any>(null)
  const [rEditMode, setREditMode] = useState(false)
  const [rFirstName, setRFirstName] = useState('')
  const [rLastName, setRLastName] = useState('')
  const [rEmail, setREmail] = useState('')
  const [rPhone, setRPhone] = useState('')
  const [rSaving, setRSaving] = useState(false)
  const [rError, setRError] = useState<string | null>(null)
  const [rNotifTitle, setRNotifTitle] = useState('')
  const [rNotifBody, setRNotifBody] = useState('')
  const [rNotifSending, setRNotifSending] = useState(false)
  const [rNotifResult, setRNotifResult] = useState<string | null>(null)

  // Karta lokalu
  const [selectedUnit, setSelectedUnit] = useState<any>(null)
  const [uEditMode, setUEditMode] = useState(false)
  const [uNumber, setUNumber] = useState('')
  const [uFloor, setUFloor] = useState('')
  const [uStairwellId, setUStairwellId] = useState('')
  const [uUnitTypeId, setUUnitTypeId] = useState('')
  const [uResidents, setUResidents] = useState<any[]>([])
  const [uSaving, setUSaving] = useState(false)
  const [uError, setUError] = useState<string | null>(null)

  // Karta pojazdu
  const [selectedVehicle, setSelectedVehicle] = useState<any>(null)
  const [veEditMode, setVeEditMode] = useState(false)
  const [veMake, setVeMake] = useState('')
  const [veModel, setVeModel] = useState('')
  const [veColor, setVeColor] = useState('')
  const [vePlate, setVePlate] = useState('')
  const [veResidentId, setVeResidentId] = useState('')
  const [veSaving, setVeSaving] = useState(false)
  const [veError, setVeError] = useState<string | null>(null)

  // ── Edge devices ─────────────────────────────────────────────────────────
  const [edgeDevices, setEdgeDevices] = useState<any[]>([])
  const [edgeGenLoading, setEdgeGenLoading] = useState(false)
  const [edgeGenResult, setEdgeGenResult] = useState<{ code: string; deviceId: string; expiresAt: string } | null>(null)
  const [edgeGenError, setEdgeGenError] = useState<string | null>(null)
  const [edgeGenType, setEdgeGenType] = useState<'EDGE' | 'EDGE_AI'>('EDGE')
  const [edgeGenName, setEdgeGenName] = useState('')
  const [edgeShowGenForm, setEdgeShowGenForm] = useState(false)

  // ── Personel ────────────────────────────────────────────────────────────────
  const [integrators, setIntegrators] = useState<any[]>([])
  const [buildingAdmins, setBuildingAdmins] = useState<any[]>([])
  const [concierges, setConcierges] = useState<any[]>([])

  // Dodaj integratora
  const [showAddInt, setShowAddInt] = useState(false)
  const [intName, setIntName] = useState('')
  const [intEmail, setIntEmail] = useState('')
  const [intPassword, setIntPassword] = useState('')
  const [intAdding, setIntAdding] = useState(false)
  const [intError, setIntError] = useState<string | null>(null)

  // Dodaj admina budynku
  const [showAddBa, setShowAddBa] = useState(false)
  const [baName, setBaName] = useState('')
  const [baEmail, setBaEmail] = useState('')
  const [baPassword, setBaPassword] = useState('')
  const [baAdding, setBaAdding] = useState(false)
  const [baError, setBaError] = useState<string | null>(null)

  // Dodaj konsjerża
  const [showAddCon, setShowAddCon] = useState(false)
  const [conName, setConName] = useState('')
  const [conEmail, setConEmail] = useState('')
  const [conPassword, setConPassword] = useState('')
  const [conAdding, setConAdding] = useState(false)
  const [conError, setConError] = useState<string | null>(null)

  // Reset hasła
  const [resetTarget, setResetTarget] = useState<{ type: 'integrator' | 'building-admin' | 'concierge'; id: number; name: string } | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetSaving, setResetSaving] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  // Archiwizacja / usunięcie
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Ustawienia części wspólnych
  const [settingsUnit, setSettingsUnit] = useState<any | null>(null)
  const [sMaxSlot, setSMaxSlot] = useState('60')
  const [sOpenTime, setSOpenTime] = useState('08:00')
  const [sCloseTime, setSCloseTime] = useState('22:00')
  const [sIsPaid, setSIsPaid] = useState(false)
  const [sPricePerHour, setSPricePerHour] = useState('')
  const [sSaving, setSSaving] = useState(false)
  const [sError, setSError] = useState<string | null>(null)

  // Dodaj część wspólną
  const [showAddCommonArea, setShowAddCommonArea] = useState(false)
  const [caTypeId, setCaTypeId] = useState('')
  const [caNumber, setCaNumber] = useState('')
  const [caAdding, setCaAdding] = useState(false)
  const [caError, setCaError] = useState<string | null>(null)

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

  const openResident = (r: any) => {
    setSelectedResident(r); setREditMode(false)
    setRFirstName(r.firstName); setRLastName(r.lastName)
    setREmail(r.email); setRPhone(r.phone ?? ''); setRError(null)
    setRNotifTitle(''); setRNotifBody(''); setRNotifResult(null)
  }

  const handleSendResidentNotif = async (e: React.FormEvent) => {
    e.preventDefault(); setRNotifSending(true); setRNotifResult(null)
    try {
      await api.post(`/buildings/${id}/notifications`, {
        title: rNotifTitle, body: rNotifBody, residentId: selectedResident.id,
      })
      setRNotifResult('Wysłano!')
      setRNotifTitle(''); setRNotifBody('')
    } catch (err: any) { setRNotifResult('Błąd: ' + (err?.response?.data?.message ?? 'nieznany błąd')) }
    finally { setRNotifSending(false) }
  }

  const handleSaveResident = async (e: React.FormEvent) => {
    e.preventDefault(); setRSaving(true); setRError(null)
    try {
      const res = await api.patch(`/buildings/${id}/residents/${selectedResident.id}`, {
        firstName: rFirstName, lastName: rLastName, email: rEmail, phone: rPhone || undefined,
      })
      setSelectedResident((prev: any) => ({ ...prev, ...res.data }))
      setREditMode(false)
      api.get(`/buildings/${id}/residents`).then((r) => setResidents(r.data))
    } catch (err: any) { setRError(err?.response?.data?.message ?? 'Błąd zapisu') }
    finally { setRSaving(false) }
  }

  const openUnit = async (u: any) => {
    setSelectedUnit(u); setUEditMode(false)
    setUNumber(u.number); setUFloor(u.floor != null ? String(u.floor) : '')
    setUStairwellId(u.stairwellId != null ? String(u.stairwellId) : '')
    setUUnitTypeId(String(u.unitTypeId)); setUError(null); setUResidents([])
    try {
      const res = await api.get(`/buildings/${id}/units/${u.id}`)
      setUResidents(res.data.unitResidents ?? [])
    } catch {}
  }

  const handleSaveUnit = async (e: React.FormEvent) => {
    e.preventDefault(); setUSaving(true); setUError(null)
    try {
      const res = await api.patch(`/buildings/${id}/units/${selectedUnit.id}`, {
        number: uNumber,
        floor: uFloor !== '' ? +uFloor : null,
        stairwellId: uStairwellId ? +uStairwellId : null,
        unitTypeId: +uUnitTypeId,
      })
      setSelectedUnit((prev: any) => ({ ...prev, ...res.data }))
      setUEditMode(false)
      api.get(`/buildings/${id}/units`).then((r) => setUnits(r.data))
    } catch (err: any) { setUError(err?.response?.data?.message ?? 'Błąd zapisu') }
    finally { setUSaving(false) }
  }

  const openVehicle = (v: any) => {
    setSelectedVehicle(v); setVeEditMode(false)
    setVeMake(v.make); setVeModel(v.model ?? ''); setVeColor(v.color)
    setVePlate(v.licensePlate); setVeResidentId(String(v.residentId)); setVeError(null)
  }

  const handleSaveVehicle = async (e: React.FormEvent) => {
    e.preventDefault(); setVeSaving(true); setVeError(null)
    try {
      const res = await api.patch(`/buildings/${id}/vehicles/${selectedVehicle.id}`, {
        make: veMake, model: veModel || undefined, color: veColor,
        licensePlate: vePlate, residentId: +veResidentId,
      })
      setSelectedVehicle(res.data)
      setVeEditMode(false)
      api.get(`/buildings/${id}/vehicles`).then((r) => setVehicles(r.data))
    } catch (err: any) { setVeError(err?.response?.data?.message ?? 'Błąd zapisu') }
    finally { setVeSaving(false) }
  }

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault()
    setSSaving(true); setSError(null)
    try {
      await api.put(`/buildings/${id}/units/${settingsUnit.id}/settings`, {
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

  // Domofony budynku
  const [intercoms, setIntercoms] = useState<any[]>([])
  const [showAddIntercom, setShowAddIntercom] = useState(false)
  const [intercomName, setIntercomName] = useState('')
  const [intercomManufacturer, setIntercomManufacturer] = useState('Akuvox')
  const [intercomModel, setIntercomModel] = useState('')
  const [intercomAdding, setIntercomAdding] = useState(false)
  const [editIntercomId, setEditIntercomId] = useState<number | null>(null)
  const [editIntercomName, setEditIntercomName] = useState('')
  const [editIntercomManufacturer, setEditIntercomManufacturer] = useState('Akuvox')
  const [editIntercomModel, setEditIntercomModel] = useState('')
  const [editIntercomIp, setEditIntercomIp] = useState('')
  const [editIntercomSipServer, setEditIntercomSipServer] = useState('')
  const [editIntercomSipAccount, setEditIntercomSipAccount] = useState('')
  const [editIntercomSipPassword, setEditIntercomSipPassword] = useState('')

  // Edycja parametrów
  // Kamery LPR
  const [lprCameras, setLprCameras] = useState<any[]>([])
  const [showAddCamera, setShowAddCamera] = useState(false)
  const [cameraName, setCameraName] = useState('')
  const [cameraManuf, setCameraManuf] = useState('')
  const [cameraModel, setCameraModel] = useState('')
  const [cameraIp, setCameraIp] = useState('')
  const [cameraLogin, setCameraLogin] = useState('')
  const [cameraPassword, setCameraPassword] = useState('')
  const [cameraLoading, setCameraLoading] = useState(false)
  const [editCameraId, setEditCameraId] = useState<number | null>(null)
  const [editCameraIp, setEditCameraIp] = useState('')
  const [editCameraLogin, setEditCameraLogin] = useState('')
  const [editCameraPassword, setEditCameraPassword] = useState('')

  const [editMode, setEditMode] = useState(false)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  // Pola formularza edycji
  const [eName, setEName] = useState('')
  const [eAddress, setEAddress] = useState('')
  const [eNip, setENip] = useState('')
  const [eRegon, setERegon] = useState('')
  const [eFloors, setEFloors] = useState('')
  const [eElevator, setEElevator] = useState(false)
  const [eCctv, setECctv] = useState(false)
  const [ePool, setEPool] = useState(false)
  const [eGym, setEGym] = useState(false)
  const [eSauna, setESauna] = useState(false)
  const [ePlayroom, setEPlayroom] = useState(false)
  const [eBanquet, setEBanquet] = useState(false)
  const [eLobby, setELobby] = useState(false)
  const [eNumberOfHouses, setENumberOfHouses] = useState('')
  const [eLightingControl, setELightingControl] = useState(false)
  const [eEdgeAI, setEEdgeAI] = useState(false)
  const [eEdge, setEEdge] = useState(false)
  const [ePhotovoltaics, setEPhotovoltaics] = useState(false)
  const [eIntercom, setEIntercom] = useState(false)
  const [eIntercomManuf, setEIntercomManuf] = useState('')
  const [eIntercomModel, setEIntercomModel] = useState('')
  const [eEntrances, setEEntrances] = useState('')
  const [eLpr, setELpr] = useState(false)
  const [eLprManuf, setELprManuf] = useState('')
  const [eLprModel, setELprModel] = useState('')
  const [ePackage, setEPackage] = useState('')

  const load = useCallback(() => {
    api.get(`/buildings/${id}`).then((r) => {
      setBuilding(r.data)
      const b = r.data
      setEName(b.name)
      setEAddress(b.address)
      setENip(b.nip ?? '')
      setERegon(b.regon ?? '')
      setEFloors(b.numberOfFloors != null ? String(b.numberOfFloors) : '')
      setENumberOfHouses(b.numberOfHouses != null ? String(b.numberOfHouses) : '')
      setEElevator(b.hasElevator)
      setECctv(b.hasCctv)
      setELightingControl(b.hasLightingControl ?? false)
      setEEdgeAI(b.hasEdgeAI ?? false)
      setEEdge(b.hasEdge ?? false)
      setEPhotovoltaics(b.hasPhotovoltaics ?? false)
      setEPool(b.hasPool)
      setEGym(b.hasGym)
      setESauna(b.hasSauna)
      setEPlayroom(b.hasPlayroom)
      setEBanquet(b.hasBanquetHall)
      setELobby(b.hasLobby)
      setEIntercom(b.hasIntercom)
      setEIntercomManuf(b.intercomManufacturer ?? '')
      setEIntercomModel(b.intercomModel ?? '')
      setEEntrances(b.entranceCount != null ? String(b.entranceCount) : '')
      setELpr(b.hasLprSystem)
      setELprManuf(b.lprManufacturer ?? '')
      setELprModel(b.lprModel ?? '')
      setEPackage(b.packageHandling ?? '')
    })
    api.get(`/buildings/${id}/units`).then((r) => setUnits(r.data))
    api.get(`/buildings/${id}/unit-types`).then((r) => setUnitTypes(r.data)).catch(() => {})
    api.get(`/buildings/${id}/residents`).then((r) => setResidents(r.data))
    api.get(`/buildings/${id}/lpr-cameras`).then((r) => setLprCameras(r.data)).catch(() => {})
    api.get(`/buildings/${id}/intercoms`).then((r) => setIntercoms(r.data)).catch(() => {})
    api.get('/integrators').then((r) => setIntegrators(r.data)).catch(() => {})
    api.get('/building-admins').then((r) => {
      setBuildingAdmins(r.data.filter((ba: any) => ba.buildings.some((b: any) => b.building.id === +(id ?? 0))))
    }).catch(() => {})
    api.get('/concierges').then((r) => {
      setConcierges(r.data.filter((c: any) => c.building?.id === +(id ?? 0)))
    }).catch(() => {})
    api.get(`/buildings/${id}/vehicles`).then((r) => setVehicles(r.data)).catch(() => {})
    api.get(`/edge/buildings/${id}/devices`).then((r) => setEdgeDevices(r.data)).catch(() => {})
  }, [id])

  useEffect(() => { load() }, [load])

  const handleArchive = async () => {
    setActionLoading(true); setActionError(null)
    try {
      await api.patch(`/buildings/${id}/archive`, {})
      router.push('/buildings')
    } catch (err: any) {
      setActionError(err?.response?.data?.message ?? 'Błąd archiwizacji')
      setActionLoading(false)
    }
  }

  const handleDelete = async () => {
    setActionLoading(true); setActionError(null)
    try {
      await api.delete(`/buildings/${id}`, { data: { confirmName: deleteConfirmName } })
      router.push('/buildings')
    } catch (err: any) {
      setActionError(err?.response?.data?.message ?? 'Błąd usunięcia')
      setActionLoading(false)
    }
  }

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    setEditSaving(true); setEditError(null)
    try {
      await api.patch(`/buildings/${id}`, {
        name: eName,
        address: eAddress,
        nip: eNip || null,
        regon: eRegon || null,
        numberOfFloors: building.objectType !== 'ESTATE' && eFloors !== '' ? Number(eFloors) : null,
        numberOfHouses: building.objectType === 'ESTATE' && eNumberOfHouses !== '' ? Number(eNumberOfHouses) : null,
        hasElevator: eElevator,
        hasCctv: eCctv,
        hasLightingControl: eLightingControl,
        hasEdgeAI: eEdgeAI,
        hasEdge: eEdge,
        hasPhotovoltaics: ePhotovoltaics,
        hasPool: ePool,
        hasGym: eGym,
        hasSauna: eSauna,
        hasPlayroom: ePlayroom,
        hasBanquetHall: eBanquet,
        hasLobby: eLobby,
        hasIntercom: eIntercom,
        intercomManufacturer: eIntercom ? 'Akuvox' : null,
        intercomModel: eIntercom ? eIntercomModel || null : null,
        entranceCount: eEntrances !== '' ? Number(eEntrances) : null,
        hasLprSystem: eLpr,
        lprManufacturer: eLpr ? eLprManuf || null : null,
        lprModel: eLpr ? eLprModel || null : null,
        packageHandling: ePackage || null,
      })
      setEditMode(false)
      load()
    } catch (err: any) {
      setEditError(err?.response?.data?.message ?? 'Błąd zapisu')
    } finally { setEditSaving(false) }
  }

  const handleDeleteUnit = async (unitId: number) => {
    if (!confirm('Usunąć tę część wspólną? Usunięte zostaną też wszystkie jej rezerwacje.')) return
    await api.delete(`/buildings/${id}/units/${unitId}`)
    load()
  }

  const handleAddCommonArea = async (e: React.FormEvent) => {
    e.preventDefault()
    setCaAdding(true); setCaError(null)
    try {
      await api.post(`/buildings/${id}/units`, { unitTypeId: +caTypeId, number: caNumber })
      setShowAddCommonArea(false)
      setCaTypeId(''); setCaNumber('')
      load()
    } catch (err: any) {
      setCaError(err?.response?.data?.message ?? 'Błąd dodawania')
    } finally { setCaAdding(false) }
  }

  // ── Personel handlers ────────────────────────────────────────────────────────
  const handleAddInt = async (e: React.FormEvent) => {
    e.preventDefault()
    setIntAdding(true); setIntError(null)
    try {
      await api.post('/integrators', { name: intName, email: intEmail, password: intPassword })
      setShowAddInt(false); setIntName(''); setIntEmail(''); setIntPassword('')
      load()
    } catch (err: any) {
      setIntError(err?.response?.data?.message ?? 'Błąd tworzenia konta')
    } finally { setIntAdding(false) }
  }

  const handleAddBa = async (e: React.FormEvent) => {
    e.preventDefault()
    setBaAdding(true); setBaError(null)
    try {
      await api.post('/building-admins', { name: baName, email: baEmail, password: baPassword, buildingIds: [+(id ?? 0)] })
      setShowAddBa(false); setBaName(''); setBaEmail(''); setBaPassword('')
      load()
    } catch (err: any) {
      setBaError(err?.response?.data?.message ?? 'Błąd tworzenia konta')
    } finally { setBaAdding(false) }
  }

  const handleAddCon = async (e: React.FormEvent) => {
    e.preventDefault()
    setConAdding(true); setConError(null)
    try {
      await api.post('/concierges', { name: conName, email: conEmail, password: conPassword, buildingId: +(id ?? 0) })
      setShowAddCon(false); setConName(''); setConEmail(''); setConPassword('')
      load()
    } catch (err: any) {
      setConError(err?.response?.data?.message ?? 'Błąd tworzenia konta')
    } finally { setConAdding(false) }
  }

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!resetTarget) return
    setResetSaving(true); setResetError(null)
    try {
      const ep =
        resetTarget.type === 'integrator' ? `/integrators/${resetTarget.id}/reset-password`
        : resetTarget.type === 'building-admin' ? `/building-admins/${resetTarget.id}/reset-password`
        : `/concierges/${resetTarget.id}/reset-password`
      await api.patch(ep, { newPassword: resetPassword })
      setResetTarget(null); setResetPassword('')
    } catch (err: any) {
      setResetError(err?.response?.data?.message ?? 'Błąd resetowania hasła')
    } finally { setResetSaving(false) }
  }

  if (!building) return <p className="text-gray-400">Ładowanie...</p>

  const amenities = [
    { key: 'hasPool', icon: '🏊', label: 'Basen' },
    { key: 'hasGym', icon: '💪', label: 'Siłownia' },
    { key: 'hasSauna', icon: '🧖', label: 'Sauna' },
    { key: 'hasPlayroom', icon: '🎮', label: 'Sala zabaw' },
    { key: 'hasBanquetHall', icon: '🎉', label: 'Sala bankietowa' },
    { key: 'hasLobby', icon: '🛋️', label: 'Lobby' },
  ].filter((a) => building[a.key])

  const isParking = building.objectType === 'PARKING'

  return (
    <div>
      {/* Nagłówek */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <Link href="/buildings" className="text-sm text-gray-400 hover:text-gray-600">← Obiekty</Link>
          <div className="flex items-center gap-2 mt-1">
            {isParking && <span className="text-2xl">🅿️</span>}
            <h1 className="text-2xl font-bold text-gray-900">{building.name}</h1>
          </div>
          <p className="text-gray-500 text-sm">{building.address}</p>
          {building.isArchived && (
            <span className="inline-block mt-1 text-xs bg-yellow-100 text-yellow-700 border border-yellow-200 px-2 py-0.5 rounded-full">
              Zarchiwizowany
            </span>
          )}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {building.isArchived ? (
            <button onClick={async () => { await api.patch(`/buildings/${id}/unarchive`, {}); load() }}
              className="text-sm px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50">
              ↩️ Przywróć
            </button>
          ) : (
            <button onClick={() => setShowArchiveConfirm(true)}
              className="text-sm px-3 py-1.5 border border-yellow-300 text-yellow-700 rounded-lg hover:bg-yellow-50">
              📦 Archiwizuj
            </button>
          )}
          <button onClick={() => setShowDeleteConfirm(true)}
            className="text-sm px-3 py-1.5 border border-red-300 text-red-600 rounded-lg hover:bg-red-50">
            🗑️ Usuń
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 mb-6">
        {(([
          { key: 'units', label: `${isParking ? 'Miejsca' : 'Lokale'} (${units.length})` },
          { key: 'residents', label: `${isParking ? 'Użytkownicy' : 'Mieszkańcy'} (${residents.length})` },
          { key: 'vehicles', label: `🚗 Pojazdy (${vehicles.length})` },
          { key: 'info', label: '⚙️ Parametry' },
          { key: 'branding', label: '🖼️ Branding' },
          { key: 'team', label: '👥 Personel' },
          ...(building?.hasEdge || building?.hasEdgeAI ? [{ key: 'edge' as const, label: `🖥️ Edge (${edgeDevices.length})` }] : []),
        ]) as Array<{ key: 'units' | 'residents' | 'vehicles' | 'info' | 'branding' | 'team' | 'edge'; label: string }>).map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`pb-3 text-sm font-medium border-b-2 transition ${
              tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── LOKALE ────────────────────────────────────────────────────────── */}
      {tab === 'units' && (() => {
        const nonCommon = units.filter((u) => !u.unitType?.isCommonArea)
        const commonUnits = units.filter((u) => u.unitType?.isCommonArea)
        const garageKw = ['garaż', 'garage', 'miejsce parkingowe']
        const storageKw = ['komórka', 'komórki', 'piwnica', 'schowek', 'magazyn']
        const isGarage  = (u: any) => garageKw.some(k => u.unitType?.name?.toLowerCase().includes(k))
        const isStorage = (u: any) => storageKw.some(k => u.unitType?.name?.toLowerCase().includes(k))
        const apartments = nonCommon.filter(u => !isGarage(u) && !isStorage(u))
        const garages    = nonCommon.filter(isGarage)
        const storage    = nonCommon.filter(isStorage)

        const UnitRow = ({ u }: { u: any }) => (
          <button onClick={() => openUnit(u)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition text-left">
            <div className="flex items-center gap-3 min-w-0">
              <div className="min-w-0">
                <span className="font-medium text-gray-900">{u.number}</span>
                <span className="ml-2 text-sm text-gray-500">{u.unitType?.name}</span>
                {u.floor != null && <span className="ml-2 text-xs text-gray-400">p. {u.floor}</span>}
                {u.stairwell && <span className="ml-2 text-xs text-blue-500">🏛️ {u.stairwell.name}</span>}
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {u.areaSqm && <span className="text-sm text-gray-400">{u.areaSqm} m²</span>}
              <span className="text-xs text-gray-300">→</span>
            </div>
          </button>
        )

        const SectionBlock = ({ icon, label, color, count, empty, children }: {
          icon: string; label: string; color: string; count: number; empty: string; children: React.ReactNode
        }) => (
          <div>
            <div className={`flex items-center gap-2 px-1 mb-2`}>
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
            {/* Toolbar */}
            <div className="flex items-center justify-between">
              <Link href={`/buildings/${id}/import`}
                className="border border-gray-300 text-gray-600 text-sm px-3 py-1.5 rounded-lg hover:bg-gray-50 transition">
                📂 Import / Eksport
              </Link>
              <Link href={`/buildings/${id}/units/new`}
                className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700">
                + {isParking ? 'Dodaj miejsce' : 'Dodaj lokal'}
              </Link>
            </div>

            {/* 1. Lokale prywatne / mieszkania */}
            <SectionBlock icon="🏠" label={isParking ? 'Miejsca parkingowe' : 'Lokale mieszkalne'} color="bg-blue-100 text-blue-700" count={apartments.length} empty="Brak lokali mieszkalnych">
              {apartments.map((u) => <UnitRow key={u.id} u={u} />)}
            </SectionBlock>

            {/* 2. Garaże */}
            {(!isParking) && (
              <SectionBlock icon="🚗" label="Garaże / miejsca parkingowe" color="bg-slate-100 text-slate-600" count={garages.length} empty="Brak garaży">
                {garages.map((u) => <UnitRow key={u.id} u={u} />)}
              </SectionBlock>
            )}

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
                {!showAddCommonArea && (
                  <button onClick={() => { setShowAddCommonArea(true); setCaError(null) }}
                    className="text-xs text-purple-600 hover:text-purple-800 font-medium">
                    + Dodaj
                  </button>
                )}
              </div>

              {showAddCommonArea && (() => {
                const commonAreaTypes = unitTypes.filter((ut: any) => ut.isCommonArea)
                return (
                  <form onSubmit={handleAddCommonArea}
                    className="mb-3 p-4 bg-purple-50 border border-purple-200 rounded-xl space-y-3">
                    <h4 className="text-sm font-semibold text-purple-800">Nowa część wspólna</h4>
                    {caError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-2">{caError}</div>}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Typ *</label>
                        <select required value={caTypeId} onChange={(e) => setCaTypeId(e.target.value)} className={inputCls}>
                          <option value="">— Wybierz —</option>
                          {commonAreaTypes.map((ut: any) => (
                            <option key={ut.id} value={ut.id}>{unitIconEmoji(ut.icon)} {ut.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Nazwa / numer *</label>
                        <input required value={caNumber} onChange={(e) => setCaNumber(e.target.value)}
                          placeholder="np. Sauna A, Siłownia 1" className={inputCls} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="submit" disabled={caAdding}
                        className="flex-1 bg-purple-600 text-white text-sm py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50">
                        {caAdding ? 'Dodawanie...' : 'Dodaj część wspólną'}
                      </button>
                      <button type="button" onClick={() => setShowAddCommonArea(false)}
                        className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                        Anuluj
                      </button>
                    </div>
                  </form>
                )
              })()}

              <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
                {commonUnits.length === 0 && !showAddCommonArea && (
                  <p className="px-5 py-4 text-sm text-gray-400 text-center">Brak części wspólnych</p>
                )}
                {commonUnits.map((u) => {
                  const s = u.commonAreaSettings
                  return (
                    <div key={u.id} className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900">{u.unitType.name} {u.number}</span>
                          {s && (
                            <span className="text-xs bg-blue-50 text-blue-600 border border-blue-200 px-1.5 py-0.5 rounded-full">
                              {s.maxSlotMinutes} min · {s.openTime}–{s.closeTime}
                              {s.isPaid && ` · ${s.pricePerHour} zł/h`}
                            </span>
                          )}
                        </div>
                        {!s && <p className="text-xs text-amber-500 mt-0.5">⚠️ Brak ustawień rezerwacji</p>}
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => openSettings(u)}
                          className="text-xs text-gray-400 hover:text-blue-600 px-2 py-1 rounded hover:bg-blue-50 transition">
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
          </div>
        )
      })()}

      {/* ── MIESZKAŃCY ────────────────────────────────────────────────────── */}
      {tab === 'residents' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <Link href={`/buildings/${id}/import`}
              className="border border-gray-300 text-gray-600 text-sm px-3 py-1.5 rounded-lg hover:bg-gray-50 transition">
              📂 Import / Eksport
            </Link>
            <Link href={`/buildings/${id}/residents/new`}
              className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700">
              + {isParking ? 'Dodaj użytkownika' : 'Dodaj mieszkańca'}
            </Link>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {residents.length === 0 && <p className="p-6 text-center text-gray-400 text-sm">
              {isParking ? 'Brak użytkowników' : 'Brak mieszkańców'}
            </p>}
            {residents.map((r) => (
              <button key={r.id} onClick={() => openResident(r)}
                className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition text-left cursor-pointer">
                <div>
                  <span className="font-medium text-gray-900">{r.firstName} {r.lastName}</span>
                  <span className="ml-2 text-sm text-gray-400">{r.email}</span>
                  {r.unitResidents?.length > 0 && (
                    <span className="ml-2 text-xs text-gray-400">
                      ({r.unitResidents.map((ur: any) => `${isParking ? 'Miejsce' : 'Lokal'} ${ur.unit?.number}`).join(', ')})
                    </span>
                  )}
                </div>
                <span className="text-xs text-gray-400">→</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── PARAMETRY ─────────────────────────────────────────────────────── */}
      {tab === 'info' && (
        <div className="space-y-4 max-w-2xl">
          {/* Przycisk edycji */}
          <div className="flex justify-end">
            <button
              onClick={() => { setEditMode(!editMode); setEditError(null) }}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              {editMode ? 'Anuluj edycję' : '✏️ Edytuj parametry'}
            </button>
          </div>

          {editMode ? (
            /* ── FORMULARZ EDYCJI ─────────────────────────────────────────── */
            <form onSubmit={handleSaveEdit} className="space-y-4">
              {editError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{editError}</div>
              )}

              {/* Dane podstawowe */}
              <EditSection title="📝 Dane podstawowe">
                <div className="grid grid-cols-2 gap-3">
                  <EditField label="Nazwa *" colSpan={2}>
                    <input type="text" value={eName} onChange={(e) => setEName(e.target.value)} required
                      className={inputCls} />
                  </EditField>
                  <EditField label="Adres *" colSpan={2}>
                    <input type="text" value={eAddress} onChange={(e) => setEAddress(e.target.value)} required
                      className={inputCls} />
                  </EditField>
                  <EditField label="NIP">
                    <input type="text" value={eNip} onChange={(e) => setENip(e.target.value)}
                      placeholder="np. 1234567890" className={inputCls} />
                  </EditField>
                  <EditField label="REGON">
                    <input type="text" value={eRegon} onChange={(e) => setERegon(e.target.value)}
                      placeholder="np. 123456789" className={inputCls} />
                  </EditField>
                </div>
              </EditSection>

              {/* Parametry ogólne */}
              <EditSection title="🏗️ Parametry ogólne">
                <div className="grid grid-cols-2 gap-3">
                  {building.objectType === 'ESTATE' ? (
                    <EditField label="Liczba domów">
                      <input type="number" min="0" value={eNumberOfHouses} onChange={(e) => setENumberOfHouses(e.target.value)}
                        placeholder="np. 24" className={inputCls} />
                    </EditField>
                  ) : (
                    <EditField label="Liczba pięter">
                      <input type="number" min="0" value={eFloors} onChange={(e) => setEFloors(e.target.value)}
                        placeholder="np. 5" className={inputCls} />
                    </EditField>
                  )}
                  <EditField label="Liczba wejść">
                    <input type="number" min="0" value={eEntrances} onChange={(e) => setEEntrances(e.target.value)}
                      placeholder="np. 2" className={inputCls} />
                  </EditField>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 mt-3">
                  <Toggle label="🛗 Winda"                        value={eElevator}        onChange={setEElevator} />
                  <Toggle label="📹 Monitoring CCTV"              value={eCctv}            onChange={setECctv} />
                  <Toggle label="💡 Oświetlenie części wspólnych" value={eLightingControl}  onChange={setELightingControl} />
                  <Toggle label="🔔 Domofon"                      value={eIntercom}        onChange={setEIntercom} />
                  <Toggle label="🚗 Kamery LPR"                   value={eLpr}             onChange={setELpr} />
                  <Toggle label="☀️ Fotowoltaika"                 value={ePhotovoltaics}   onChange={setEPhotovoltaics} />
                  <Toggle label="📦 Obsługa przesyłek"            value={ePackage !== ''}  onChange={(v) => setEPackage(v ? 'CONCIERGE' : '')} />
                </div>
                {ePackage !== '' && (
                  <div className="border-t border-gray-100 pt-3 mt-1">
                    <p className="text-xs font-medium text-gray-600 mb-2">Sposób obsługi przesyłek:</p>
                    <div className="flex gap-2">
                      {[
                        { val: 'CONCIERGE', icon: '🧑‍💼', label: 'Przez konsjerża' },
                        { val: 'LOCKER',    icon: '📦',   label: 'Paczkomat Pointpack' },
                      ].map(({ val, icon, label }) => (
                        <button key={val} type="button" onClick={() => setEPackage(val)}
                          className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border-2 transition ${
                            ePackage === val
                              ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                              : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                          }`}>
                          <span>{icon}</span>{label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </EditSection>

              {/* GateLynk Edge */}
              <EditSection title="🖥️ Sprzęt GateLynk Edge">
                <div className="space-y-3">
                  <button type="button" onClick={() => setEEdge(!eEdge)}
                    className={`w-full text-left p-4 rounded-xl border-2 transition ${
                      eEdge ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}>
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition ${
                        eEdge ? 'border-blue-500 bg-blue-500' : 'border-gray-300'
                      }`}>
                        {eEdge && <div className="w-2 h-2 bg-white rounded-full" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-gray-900">GateLynk Edge</span>
                          <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">Mac Mini</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">Domofon · Kamery IP · Winda · Oświetlenie LAN</p>
                      </div>
                    </div>
                  </button>
                  <button type="button" onClick={() => setEEdgeAI(!eEdgeAI)}
                    className={`w-full text-left p-4 rounded-xl border-2 transition ${
                      eEdgeAI ? 'border-violet-500 bg-violet-50' : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}>
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition ${
                        eEdgeAI ? 'border-violet-500 bg-violet-500' : 'border-gray-300'
                      }`}>
                        {eEdgeAI && <div className="w-2 h-2 bg-white rounded-full" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-gray-900">GateLynk Edge AI</span>
                          <span className="text-xs bg-violet-100 text-violet-600 px-2 py-0.5 rounded-full font-medium">HP ZGX Nano</span>
                          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">⚡ AI onsite</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">Analityka AI · LPR/ANPR · Rozpoznawanie twarzy · Detekcja zagrożeń</p>
                      </div>
                    </div>
                  </button>
                </div>
              </EditSection>

              {/* Udogodnienia */}
              <EditSection title="✨ Udogodnienia">
                <div className="flex flex-wrap gap-2">
                  {[
                    { key: 'pool', label: '🏊 Basen', val: ePool, set: setEPool },
                    { key: 'gym', label: '💪 Siłownia', val: eGym, set: setEGym },
                    { key: 'sauna', label: '🧖 Sauna', val: eSauna, set: setESauna },
                    { key: 'play', label: '🎮 Sala zabaw', val: ePlayroom, set: setEPlayroom },
                    { key: 'banq', label: '🎉 Sala bankietowa', val: eBanquet, set: setEBanquet },
                    { key: 'lobby', label: '🛋️ Lobby', val: eLobby, set: setELobby },
                  ].map((a) => (
                    <button key={a.key} type="button" onClick={() => a.set(!a.val)}
                      className={`text-sm px-3 py-1.5 rounded-full border transition ${
                        a.val ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                      }`}>
                      {a.label}
                    </button>
                  ))}
                </div>
              </EditSection>

              {/* Domofon — szczegóły */}
              {eIntercom && (
                <EditSection title="🔔 Domofon — szczegóły">
                  <div className="grid grid-cols-2 gap-3">
                    <EditField label="Producent">
                      <select value={eIntercomManuf} onChange={(e) => { setEIntercomManuf(e.target.value); setEIntercomModel('') }} className={inputCls}>
                        <option value="">— Wybierz —</option>
                        {INTERCOM_MANUFACTURERS.map((m) => <option key={m}>{m}</option>)}
                      </select>
                    </EditField>
                    <EditField label="Model">
                      <select value={eIntercomModel} onChange={(e) => setEIntercomModel(e.target.value)}
                        className={inputCls} disabled={!eIntercomManuf}>
                        <option value="">— Wybierz model —</option>
                        {(INTERCOM_MODELS[eIntercomManuf] ?? []).map((m) => <option key={m}>{m}</option>)}
                      </select>
                    </EditField>
                  </div>
                </EditSection>
              )}

              {/* System LPR — szczegóły */}
              {eLpr && (
                <EditSection title="🚗 System LPR — szczegóły">
                  <div className="grid grid-cols-2 gap-3">
                    <EditField label="Producent kamery">
                      <select value={eLprManuf}
                        onChange={(e) => { setELprManuf(e.target.value); setELprModel('') }}
                        className={inputCls}>
                        <option value="">— Wybierz —</option>
                        {LPR_MANUFACTURERS.map((m) => <option key={m}>{m}</option>)}
                      </select>
                    </EditField>
                    <EditField label="Model kamery">
                      <select value={eLprModel} onChange={(e) => setELprModel(e.target.value)}
                        disabled={!eLprManuf || (LPR_MODELS[eLprManuf]?.length === 0)}
                        className={inputCls}>
                        <option value="">— Wybierz —</option>
                        {(LPR_MODELS[eLprManuf] ?? []).map((m) => <option key={m}>{m}</option>)}
                      </select>
                    </EditField>
                  </div>
                </EditSection>
              )}

              <button type="submit" disabled={editSaving}
                className="w-full bg-blue-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition">
                {editSaving ? 'Zapisywanie...' : 'Zapisz zmiany'}
              </button>
            </form>
          ) : (
            /* ── WIDOK PARAMETRÓW ─────────────────────────────────────────── */
            <>
              <InfoCard title="🏗️ Parametry ogólne">
                {building.objectType === 'ESTATE'
                  ? <InfoRow label="Liczba domów" value={building.numberOfHouses != null ? `${building.numberOfHouses} domów` : null} />
                  : <InfoRow label="Liczba pięter" value={building.numberOfFloors != null ? `${building.numberOfFloors} pięter` : null} />
                }
                <InfoRow label="🛗 Winda"                        value={building.hasElevator        ? '✅ Tak' : '❌ Nie'} />
                <InfoRow label="📹 Monitoring CCTV"              value={building.hasCctv            ? '✅ Tak' : '❌ Nie'} />
                <InfoRow label="💡 Oświetlenie części wspólnych" value={building.hasLightingControl  ? '✅ Tak' : '❌ Nie'} />
                <InfoRow label="🔔 Domofon"                      value={building.hasIntercom        ? '✅ Tak' : '❌ Nie'} />
                <InfoRow label="🚗 Kamery LPR"                   value={building.hasLprSystem       ? '✅ Tak' : '❌ Nie'} />
                <InfoRow label="🖥️ GateLynk Edge"               value={building.hasEdge            ? '✅ Mac Mini' : '❌ Nie'} />
                <InfoRow label="🤖 GateLynk Edge AI"             value={building.hasEdgeAI          ? '✅ HP ZGX Nano' : '❌ Nie'} />
                <InfoRow label="☀️ Fotowoltaika"                 value={building.hasPhotovoltaics   ? '✅ Tak' : '❌ Nie'} />
                <InfoRow label="📦 Obsługa przesyłek"            value={building.packageHandling ? packageLabel[building.packageHandling] : '❌ Nie'} />
                {building.nip && <InfoRow label="NIP" value={building.nip} />}
                {building.regon && <InfoRow label="REGON" value={building.regon} />}
              </InfoCard>

              <InfoCard title="✨ Udogodnienia">
                {amenities.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {amenities.map((a) => (
                      <span key={a.key}
                        className="flex items-center gap-1.5 bg-green-50 text-green-700 border border-green-200 text-sm px-3 py-1 rounded-full">
                        {a.icon} {a.label}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">Brak zdefiniowanych udogodnień</p>
                )}
              </InfoCard>

              <InfoCard title="🔔 Domofon">
                <InfoRow label="Domofon" value={building.hasIntercom ? '✅ Tak' : '❌ Nie'} />
                {building.hasIntercom && (
                  <>
                    {building.intercomManufacturer && <InfoRow label="Producent" value={building.intercomManufacturer} />}
                    {building.intercomModel && <InfoRow label="Model" value={building.intercomModel} />}
                    {building.entranceCount != null && <InfoRow label="Liczba wejść" value={`${building.entranceCount}`} />}
                  </>
                )}
              </InfoCard>

              {/* Domofony — lista */}
              {building.hasIntercom && (
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-gray-800">🔔 Domofony</h3>
                    {!showAddIntercom && (
                      <button onClick={() => { setShowAddIntercom(true); setIntercomName(''); setIntercomModel('') }}
                        className="text-sm text-blue-600 hover:text-blue-800 font-medium">
                        + Dodaj domofon
                      </button>
                    )}
                  </div>

                  {showAddIntercom && (
                    <form onSubmit={async (e) => {
                      e.preventDefault(); setIntercomAdding(true)
                      try {
                        const fullModel = intercomManufacturer && intercomModel
                          ? `${intercomManufacturer} ${intercomModel}`
                          : intercomManufacturer || intercomModel || undefined
                        await api.post(`/buildings/${id}/intercoms`, { name: intercomName, model: fullModel })
                        setShowAddIntercom(false); setIntercomManufacturer('Akuvox'); setIntercomModel(''); load()
                      } finally { setIntercomAdding(false) }
                    }} className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Nazwa wejścia *</label>
                          <input required value={intercomName} onChange={(e) => setIntercomName(e.target.value)}
                            placeholder="np. Wejście 1, Brama główna" className={inputCls} />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Producent</label>
                          <select value={intercomManufacturer} onChange={(e) => { setIntercomManufacturer(e.target.value); setIntercomModel('') }} className={inputCls}>
                            <option value="">— wybierz —</option>
                            {INTERCOM_MANUFACTURERS.map((m) => <option key={m}>{m}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Model</label>
                          <select value={intercomModel} onChange={(e) => setIntercomModel(e.target.value)} className={inputCls} disabled={!intercomManufacturer}>
                            <option value="">— wybierz model —</option>
                            {(INTERCOM_MODELS[intercomManufacturer] ?? []).map((m) => <option key={m}>{m}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button type="submit" disabled={intercomAdding}
                          className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                          {intercomAdding ? 'Dodawanie...' : 'Dodaj'}
                        </button>
                        <button type="button" onClick={() => setShowAddIntercom(false)}
                          className="flex-1 border border-gray-300 text-gray-600 text-sm py-2 rounded-lg hover:bg-gray-50">
                          Anuluj
                        </button>
                      </div>
                    </form>
                  )}

                  {intercoms.length === 0 && !showAddIntercom && (
                    <p className="text-sm text-gray-400">Brak domofonów. Kliknij „+ Dodaj domofon" aby dodać.</p>
                  )}

                  <div className="space-y-2">
                    {intercoms.map((ic) => (
                      <div key={ic.id} className="border border-gray-100 rounded-lg p-3">
                        {editIntercomId === ic.id ? (
                          <div className="space-y-2">
                            <div className="grid grid-cols-2 gap-2">
                              <div className="col-span-2 grid grid-cols-3 gap-2">
                                <div>
                                  <label className="block text-xs text-gray-500 mb-1">Nazwa wejścia *</label>
                                  <input required value={editIntercomName} onChange={(e) => setEditIntercomName(e.target.value)}
                                    className={inputCls} />
                                </div>
                                <div>
                                  <label className="block text-xs text-gray-500 mb-1">Producent</label>
                                  <select value={editIntercomManufacturer} onChange={(e) => { setEditIntercomManufacturer(e.target.value); setEditIntercomModel('') }} className={inputCls}>
                                    <option value="">— wybierz —</option>
                                    {INTERCOM_MANUFACTURERS.map((m) => <option key={m}>{m}</option>)}
                                  </select>
                                </div>
                                <div>
                                  <label className="block text-xs text-gray-500 mb-1">Model</label>
                                  <select value={editIntercomModel} onChange={(e) => setEditIntercomModel(e.target.value)} className={inputCls} disabled={!editIntercomManufacturer}>
                                    <option value="">— wybierz model —</option>
                                    {(INTERCOM_MODELS[editIntercomManufacturer] ?? []).map((m) => <option key={m}>{m}</option>)}
                                  </select>
                                </div>
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">Adres IP</label>
                                <input value={editIntercomIp} onChange={(e) => setEditIntercomIp(e.target.value)}
                                  placeholder="192.168.1.x" className={inputCls} />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">Serwer SIP</label>
                                <input value={editIntercomSipServer} onChange={(e) => setEditIntercomSipServer(e.target.value)}
                                  placeholder="sip.example.com" className={inputCls} />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">Konto SIP</label>
                                <input value={editIntercomSipAccount} onChange={(e) => setEditIntercomSipAccount(e.target.value)} className={inputCls} />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">Hasło SIP</label>
                                <input value={editIntercomSipPassword} onChange={(e) => setEditIntercomSipPassword(e.target.value)} className={inputCls} />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={async () => {
                                const fullModel = editIntercomManufacturer && editIntercomModel
                                  ? `${editIntercomManufacturer} ${editIntercomModel}`
                                  : editIntercomManufacturer || editIntercomModel || undefined
                                await api.patch(`/buildings/${id}/intercoms/${ic.id}`, {
                                  name: editIntercomName,
                                  model: fullModel,
                                  ipAddress: editIntercomIp || undefined,
                                  sipServer: editIntercomSipServer || undefined,
                                  sipAccount: editIntercomSipAccount || undefined,
                                  sipPassword: editIntercomSipPassword || undefined,
                                })
                                setEditIntercomId(null); load()
                              }} className="flex-1 bg-blue-600 text-white text-xs py-1.5 rounded-lg hover:bg-blue-700">
                                Zapisz
                              </button>
                              <button onClick={() => setEditIntercomId(null)}
                                className="flex-1 border border-gray-200 text-gray-600 text-xs py-1.5 rounded-lg hover:bg-gray-50">
                                Anuluj
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium text-gray-800">🔔 {ic.name}</p>
                              <div className="flex flex-wrap gap-2 mt-0.5">
                                {ic.model && <span className="text-xs text-gray-500">{ic.model}</span>}
                                {ic.ipAddress && <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">IP: {ic.ipAddress}</span>}
                                {ic.sipAccount && <span className="text-xs text-green-600 bg-green-50 px-1.5 py-0.5 rounded">SIP ✓</span>}
                                {!ic.model && !ic.ipAddress && (
                                  <span className="text-xs text-amber-500">⚠️ Brak konfiguracji integratora</span>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => {
                                setEditIntercomId(ic.id)
                                setEditIntercomName(ic.name)
                                // Rozdziel zapisany "Producent Model" z powrotem
                                const savedModel = ic.model ?? ''
                                const matchedManuf = INTERCOM_MANUFACTURERS.find((manuf) => savedModel.startsWith(manuf + ' ')) ?? ''
                                setEditIntercomManufacturer(matchedManuf)
                                setEditIntercomModel(matchedManuf ? savedModel.slice(matchedManuf.length + 1) : savedModel)
                                setEditIntercomIp(ic.ipAddress ?? '')
                                setEditIntercomSipServer(ic.sipServer ?? '')
                                setEditIntercomSipAccount(ic.sipAccount ?? '')
                                setEditIntercomSipPassword(ic.sipPassword ?? '')
                              }} className="text-xs text-gray-400 hover:text-blue-600">✏️</button>
                              <button onClick={async () => {
                                if (!confirm(`Usunąć domofon "${ic.name}"?`)) return
                                await api.delete(`/buildings/${id}/intercoms/${ic.id}`); load()
                              }} className="text-xs text-gray-400 hover:text-red-600">🗑️</button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <InfoCard title="🚗 System LPR">
                <InfoRow label="System LPR" value={building.hasLprSystem ? '✅ Tak' : '❌ Nie'} />
                {building.hasLprSystem && (
                  <>
                    {building.lprManufacturer && <InfoRow label="Producent kamery" value={building.lprManufacturer} />}
                    {building.lprModel && <InfoRow label="Model kamery" value={building.lprModel} />}
                  </>
                )}
              </InfoCard>

              {building.hasLprSystem && (
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-gray-800">📷 Kamery LPR</h3>
                    <button onClick={() => { setShowAddCamera(true); setCameraName(''); setCameraManuf(''); setCameraModel(''); setCameraIp(''); setCameraLogin(''); setCameraPassword('') }}
                      className="text-sm text-blue-600 hover:text-blue-800 font-medium">+ Dodaj kamerę</button>
                  </div>

                  {showAddCamera && (
                    <form onSubmit={async (e) => {
                      e.preventDefault(); setCameraLoading(true)
                      try {
                        await api.post(`/buildings/${id}/lpr-cameras`, { name: cameraName, manufacturer: cameraManuf, model: cameraModel || null, ipAddress: cameraIp || null, login: cameraLogin || null, password: cameraPassword || null })
                        setShowAddCamera(false); load()
                      } finally { setCameraLoading(false) }
                    }} className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="col-span-2">
                          <label className="block text-xs text-gray-600 mb-1">Nazwa *</label>
                          <input required value={cameraName} onChange={(e) => setCameraName(e.target.value)} placeholder="np. Wjazd P1" className={inputCls} />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Producent *</label>
                          <select required value={cameraManuf} onChange={(e) => { setCameraManuf(e.target.value); setCameraModel('') }} className={inputCls}>
                            <option value="">— Wybierz —</option>
                            {LPR_MANUFACTURERS.map((m) => <option key={m}>{m}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Model</label>
                          <select value={cameraModel} onChange={(e) => setCameraModel(e.target.value)} disabled={!cameraManuf} className={inputCls}>
                            <option value="">— Wybierz —</option>
                            {(LPR_MODELS[cameraManuf] ?? []).map((m) => <option key={m}>{m}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Adres IP</label>
                          <input value={cameraIp} onChange={(e) => setCameraIp(e.target.value)} placeholder="192.168.1.x" className={inputCls} />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Login</label>
                          <input value={cameraLogin} onChange={(e) => setCameraLogin(e.target.value)} className={inputCls} />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-gray-600 mb-1">Hasło</label>
                          <input value={cameraPassword} onChange={(e) => setCameraPassword(e.target.value)} className={inputCls} />
                        </div>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button type="submit" disabled={cameraLoading} className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                          {cameraLoading ? 'Dodawanie...' : 'Dodaj'}
                        </button>
                        <button type="button" onClick={() => setShowAddCamera(false)} className="flex-1 border border-gray-300 text-gray-600 text-sm py-2 rounded-lg hover:bg-gray-50">
                          Anuluj
                        </button>
                      </div>
                    </form>
                  )}

                  {lprCameras.length === 0 && !showAddCamera && (
                    <p className="text-sm text-gray-400">Brak kamer. Integrator może skonfigurować dane dostępowe.</p>
                  )}

                  <div className="space-y-2">
                    {lprCameras.map((cam) => (
                      <div key={cam.id} className="border border-gray-100 rounded-lg p-3">
                        {editCameraId === cam.id ? (
                          <div className="space-y-2">
                            <p className="text-sm font-medium text-gray-700">{cam.name} — {cam.manufacturer}</p>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">Adres IP</label>
                                <input value={editCameraIp} onChange={(e) => setEditCameraIp(e.target.value)} placeholder="192.168.1.x" className={inputCls} />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">Login</label>
                                <input value={editCameraLogin} onChange={(e) => setEditCameraLogin(e.target.value)} className={inputCls} />
                              </div>
                              <div className="col-span-2">
                                <label className="block text-xs text-gray-500 mb-1">Hasło</label>
                                <input value={editCameraPassword} onChange={(e) => setEditCameraPassword(e.target.value)} className={inputCls} />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={async () => {
                                await api.patch(`/buildings/${id}/lpr-cameras/${cam.id}`, { ipAddress: editCameraIp || null, login: editCameraLogin || null, password: editCameraPassword || null })
                                setEditCameraId(null); load()
                              }} className="flex-1 bg-blue-600 text-white text-xs py-1.5 rounded-lg hover:bg-blue-700">Zapisz</button>
                              <button onClick={() => setEditCameraId(null)} className="flex-1 border border-gray-200 text-gray-600 text-xs py-1.5 rounded-lg hover:bg-gray-50">Anuluj</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium text-gray-800">{cam.name}</p>
                              <p className="text-xs text-gray-400">{cam.manufacturer}{cam.model ? ` · ${cam.model}` : ''}{cam.ipAddress ? ` · ${cam.ipAddress}` : ''}</p>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => { setEditCameraId(cam.id); setEditCameraIp(cam.ipAddress ?? ''); setEditCameraLogin(cam.login ?? ''); setEditCameraPassword(cam.password ?? '') }}
                                className="text-xs text-gray-400 hover:text-blue-600">✏️</button>
                              <button onClick={async () => { await api.delete(`/buildings/${id}/lpr-cameras/${cam.id}`); load() }}
                                className="text-xs text-gray-400 hover:text-red-600">🗑️</button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <InfoCard title="📦 Obsługa paczek">
                <InfoRow label="Sposób obsługi"
                  value={building.packageHandling ? packageLabel[building.packageHandling] : '❌ Brak'} />
              </InfoCard>

              <InfoCard title="🏛️ Klatki schodowe">
                {building.stairwells?.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {building.stairwells.map((sw: any) => (
                      <Link key={sw.id} href={`/buildings/${id}/stairwells/${sw.id}`}
                        className="flex items-center gap-1.5 bg-blue-50 text-blue-700 border border-blue-200 text-sm px-3 py-1 rounded-full hover:bg-blue-100 transition">
                        🏛️ {sw.name}
                        {sw.intercom && <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full ml-1">📟 Akuvox</span>}
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">Brak zdefiniowanych klatek</p>
                )}
              </InfoCard>
            </>
          )}
        </div>
      )}

      {/* ── POJAZDY ───────────────────────────────────────────────────────── */}
      {tab === 'vehicles' && (
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
          onAdd={async (e) => {
            e.preventDefault()
            setVAdding(true); setVError(null)
            try {
              await api.post(`/buildings/${id}/vehicles`, {
                residentId: +vResidentId, make: vMake, model: vModel || undefined, color: vColor, licensePlate: vPlate,
              })
              setShowAddVehicle(false)
              setVResidentId(''); setVMake(''); setVModel(''); setVColor(''); setVPlate('')
              api.get(`/buildings/${id}/vehicles`).then((r) => setVehicles(r.data))
            } catch (err: any) {
              setVError(err?.response?.data?.message ?? 'Błąd dodawania pojazdu')
            } finally { setVAdding(false) }
          }}
          onDelete={async (vehicleId) => {
            if (!confirm('Usunąć ten pojazd?')) return
            await api.delete(`/buildings/${id}/vehicles/${vehicleId}`)
            api.get(`/buildings/${id}/vehicles`).then((r) => setVehicles(r.data))
          }}
          onSelect={(v) => openVehicle(v)}
          canEdit={true}
        />
      )}

      {/* ── PERSONEL ──────────────────────────────────────────────────────── */}
      {tab === 'branding' && (
        <BrandingTab
          building={building}
          uploading={brandingUploading}
          onUpload={async (field, base64) => {
            setBrandingUploading(field === 'logoBase64' ? 'logo' : 'bg')
            try {
              await api.patch(`/buildings/${id}`, { [field]: base64 })
              await load()
            } finally { setBrandingUploading(null) }
          }}
          onRemove={async (field) => {
            await api.patch(`/buildings/${id}`, { [field]: null })
            await load()
          }}
        />
      )}

      {tab === 'team' && (
        <div className="space-y-6 max-w-2xl">

          {/* Integratorzy */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-gray-900">🔧 Integratorzy</h2>
                <p className="text-xs text-gray-400 mt-0.5">Konfigurują domofony i systemy LPR. Mają dostęp do wszystkich budynków.</p>
              </div>
              {!showAddInt && (
                <button onClick={() => { setShowAddInt(true); setIntError(null) }}
                  className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 flex-shrink-0">
                  + Dodaj
                </button>
              )}
            </div>

            {showAddInt && (
              <form onSubmit={handleAddInt}
                className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
                <h3 className="text-sm font-semibold text-blue-800">Nowy integrator</h3>
                {intError && <ErrBanner msg={intError} />}
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className={teamLabelCls}>Imię i nazwisko / Nazwa firmy *</label>
                    <input required value={intName} onChange={(e) => setIntName(e.target.value)}
                      placeholder="np. Jan Kowalski" className={inputCls} />
                  </div>
                  <div>
                    <label className={teamLabelCls}>Adres email *</label>
                    <input required type="email" value={intEmail} onChange={(e) => setIntEmail(e.target.value)}
                      placeholder="integrator@firma.pl" className={inputCls} />
                  </div>
                  <div>
                    <label className={teamLabelCls}>Hasło *</label>
                    <input required type="password" minLength={8} value={intPassword}
                      onChange={(e) => setIntPassword(e.target.value)}
                      placeholder="min. 8 znaków" className={inputCls} />
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={intAdding}
                    className="flex-1 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                    {intAdding ? 'Tworzenie...' : 'Utwórz konto'}
                  </button>
                  <button type="button" onClick={() => setShowAddInt(false)}
                    className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">
                    Anuluj
                  </button>
                </div>
              </form>
            )}

            {integrators.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">Brak integratorów</p>
            ) : (
              <div className="divide-y divide-gray-100 -mx-5">
                {integrators.map((int) => (
                  <TeamRow key={int.id} name={int.name} email={int.email} createdAt={int.createdAt}
                    onReset={() => { setResetTarget({ type: 'integrator', id: int.id, name: int.name }); setResetPassword(''); setResetError(null) }}
                    onDelete={async () => {
                      if (!confirm(`Usunąć konto integratora "${int.name}"?`)) return
                      await api.delete(`/integrators/${int.id}`); load()
                    }} />
                ))}
              </div>
            )}
          </div>

          {/* Administratorzy budynku */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-gray-900">🏢 Administratorzy budynku</h2>
                <p className="text-xs text-gray-400 mt-0.5">Zarządzają tym budynkiem: mieszkańcy, lokale, klatki i powiadomienia.</p>
              </div>
              {!showAddBa && (
                <button onClick={() => { setShowAddBa(true); setBaError(null) }}
                  className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 flex-shrink-0">
                  + Dodaj
                </button>
              )}
            </div>

            {showAddBa && (
              <form onSubmit={handleAddBa}
                className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
                <h3 className="text-sm font-semibold text-blue-800">Nowy administrator budynku</h3>
                {baError && <ErrBanner msg={baError} />}
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className={teamLabelCls}>Imię i nazwisko *</label>
                    <input required value={baName} onChange={(e) => setBaName(e.target.value)}
                      placeholder="np. Anna Nowak" className={inputCls} />
                  </div>
                  <div>
                    <label className={teamLabelCls}>Adres email *</label>
                    <input required type="email" value={baEmail} onChange={(e) => setBaEmail(e.target.value)}
                      placeholder="admin@budynek.pl" className={inputCls} />
                  </div>
                  <div>
                    <label className={teamLabelCls}>Hasło *</label>
                    <input required type="password" minLength={8} value={baPassword}
                      onChange={(e) => setBaPassword(e.target.value)}
                      placeholder="min. 8 znaków" className={inputCls} />
                  </div>
                </div>
                <p className="text-xs text-gray-400">📌 Konto zostanie przypisane do tego budynku.</p>
                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={baAdding}
                    className="flex-1 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                    {baAdding ? 'Tworzenie...' : 'Utwórz konto'}
                  </button>
                  <button type="button" onClick={() => setShowAddBa(false)}
                    className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">
                    Anuluj
                  </button>
                </div>
              </form>
            )}

            {buildingAdmins.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">Brak administratorów budynku</p>
            ) : (
              <div className="divide-y divide-gray-100 -mx-5">
                {buildingAdmins.map((ba) => (
                  <TeamRow key={ba.id} name={ba.name} email={ba.email} createdAt={ba.createdAt}
                    onReset={() => { setResetTarget({ type: 'building-admin', id: ba.id, name: ba.name }); setResetPassword(''); setResetError(null) }}
                    onDelete={async () => {
                      if (!confirm(`Usunąć konto administratora "${ba.name}"?`)) return
                      await api.delete(`/building-admins/${ba.id}`); load()
                    }} />
                ))}
              </div>
            )}
          </div>

          {/* Konsjerże */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-gray-900">🎩 Konsjerże</h2>
                <p className="text-xs text-gray-400 mt-0.5">Wgląd w mieszkańców i lokale, wysyłanie powiadomień, obsługa rezerwacji.</p>
              </div>
              {!showAddCon && (
                <button onClick={() => { setShowAddCon(true); setConError(null) }}
                  className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 flex-shrink-0">
                  + Dodaj
                </button>
              )}
            </div>

            {showAddCon && (
              <form onSubmit={handleAddCon}
                className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
                <h3 className="text-sm font-semibold text-blue-800">Nowe konto konsjerża</h3>
                {conError && <ErrBanner msg={conError} />}
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className={teamLabelCls}>Imię i nazwisko *</label>
                    <input required value={conName} onChange={(e) => setConName(e.target.value)}
                      placeholder="np. Marek Wiśniewski" className={inputCls} />
                  </div>
                  <div>
                    <label className={teamLabelCls}>Adres email *</label>
                    <input required type="email" value={conEmail} onChange={(e) => setConEmail(e.target.value)}
                      placeholder="konsjerz@budynek.pl" className={inputCls} />
                  </div>
                  <div>
                    <label className={teamLabelCls}>Hasło *</label>
                    <input required type="password" minLength={8} value={conPassword}
                      onChange={(e) => setConPassword(e.target.value)}
                      placeholder="min. 8 znaków" className={inputCls} />
                  </div>
                </div>
                <p className="text-xs text-gray-400">📌 Konto zostanie przypisane do tego budynku.</p>
                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={conAdding}
                    className="flex-1 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                    {conAdding ? 'Tworzenie...' : 'Utwórz konto'}
                  </button>
                  <button type="button" onClick={() => setShowAddCon(false)}
                    className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">
                    Anuluj
                  </button>
                </div>
              </form>
            )}

            {concierges.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">Brak konsjerżów</p>
            ) : (
              <div className="divide-y divide-gray-100 -mx-5">
                {concierges.map((con) => (
                  <TeamRow key={con.id} name={con.name} email={con.email} createdAt={con.createdAt}
                    onReset={() => { setResetTarget({ type: 'concierge', id: con.id, name: con.name }); setResetPassword(''); setResetError(null) }}
                    onDelete={async () => {
                      if (!confirm(`Usunąć konto konsjerża "${con.name}"?`)) return
                      await api.delete(`/concierges/${con.id}`); load()
                    }} />
                ))}
              </div>
            )}
          </div>

          {/* Linki do paneli */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Panel integratora', href: '/integrator/login' },
              { label: 'Panel administratora budynku', href: '/building-admin/login' },
              { label: 'Panel konsjerża', href: '/concierge/login' },
            ].map((l) => (
              <div key={l.href} className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-center">
                <p className="text-xs text-gray-500 mb-1">{l.label}</p>
                <code className="text-xs font-mono text-blue-700 bg-white border border-gray-200 px-2 py-0.5 rounded">
                  {l.href}
                </code>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── EDGE DEVICES ──────────────────────────────────────────────────── */}
      {tab === 'edge' && (
        <div className="space-y-5 max-w-2xl">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-gray-900">🖥️ Urządzenia GateLynk Edge</h2>
                <p className="text-xs text-gray-400 mt-0.5">Urządzenia on-premise zainstalowane w budynku</p>
              </div>
              <button
                onClick={() => { setEdgeShowGenForm(true); setEdgeGenResult(null); setEdgeGenError(null); setEdgeGenName('') }}
                className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700 flex-shrink-0">
                + Generuj kod aktywacyjny
              </button>
            </div>

            {edgeShowGenForm && !edgeGenResult && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault()
                  setEdgeGenLoading(true); setEdgeGenError(null)
                  try {
                    const res = await api.post(`/edge/buildings/${id}/activation-code`, {
                      type: edgeGenType,
                      name: edgeGenName || undefined,
                    })
                    setEdgeGenResult(res.data)
                    api.get(`/edge/buildings/${id}/devices`).then((r) => setEdgeDevices(r.data)).catch(() => {})
                  } catch (err: any) {
                    setEdgeGenError(err?.response?.data?.message ?? 'Błąd generowania kodu')
                  } finally { setEdgeGenLoading(false) }
                }}
                className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
                <h3 className="text-sm font-semibold text-blue-800">Nowe urządzenie Edge</h3>
                {edgeGenError && <ErrBanner msg={edgeGenError} />}
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Typ urządzenia</label>
                  <div className="flex gap-2">
                    {(['EDGE', 'EDGE_AI'] as const).map((t) => (
                      <button key={t} type="button"
                        onClick={() => setEdgeGenType(t)}
                        className={`flex-1 text-sm px-3 py-2 rounded-lg border transition font-medium ${
                          edgeGenType === t
                            ? t === 'EDGE_AI' ? 'bg-violet-50 border-violet-400 text-violet-700' : 'bg-blue-50 border-blue-400 text-blue-700'
                            : 'border-gray-200 text-gray-500 hover:border-gray-300'
                        }`}>
                        {t === 'EDGE' ? '🖥️ GateLynk Edge' : '🤖 GateLynk Edge AI'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Nazwa urządzenia (opcjonalnie)</label>
                  <input value={edgeGenName} onChange={(e) => setEdgeGenName(e.target.value)}
                    placeholder={`GateLynk ${edgeGenType === 'EDGE_AI' ? 'Edge AI' : 'Edge'} — ${building?.name ?? ''}`}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div className="flex gap-2">
                  <button type="submit" disabled={edgeGenLoading}
                    className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                    {edgeGenLoading ? 'Generowanie...' : 'Generuj kod'}
                  </button>
                  <button type="button" onClick={() => setEdgeShowGenForm(false)}
                    className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                    Anuluj
                  </button>
                </div>
              </form>
            )}

            {edgeGenResult && (
              <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-green-800">✅ Kod aktywacyjny wygenerowany</h3>
                  <button onClick={() => { setEdgeShowGenForm(false); setEdgeGenResult(null) }}
                    className="text-xs text-gray-400 hover:text-gray-600">✕ Zamknij</button>
                </div>
                <p className="text-xs text-green-700 mb-3">Wprowadź ten kod na urządzeniu GateLynk Edge podczas pierwszego uruchomienia.</p>
                <div className="bg-white border border-green-300 rounded-lg p-3 text-center">
                  <p className="text-2xl font-mono font-bold tracking-widest text-gray-900">{edgeGenResult.code}</p>
                </div>
                <p className="text-xs text-gray-400 mt-2 text-center">
                  Ważny do: {new Date(edgeGenResult.expiresAt).toLocaleString('pl-PL')}
                </p>
                <button
                  onClick={() => navigator.clipboard.writeText(edgeGenResult!.code)}
                  className="mt-2 w-full border border-green-300 text-green-700 text-xs py-1.5 rounded-lg hover:bg-green-100">
                  📋 Kopiuj kod
                </button>
              </div>
            )}

            {edgeDevices.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">Brak zarejestrowanych urządzeń Edge</p>
            ) : (
              <div className="divide-y divide-gray-100 -mx-5">
                {edgeDevices.map((d) => (
                  <div key={d.id} className="px-5 py-3 flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${d.isOnline ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate">{d.name ?? d.id}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                          d.type === 'EDGE_AI'
                            ? 'bg-violet-100 text-violet-700'
                            : 'bg-blue-100 text-blue-700'
                        }`}>{d.type === 'EDGE_AI' ? '🤖 Edge AI' : '🖥️ Edge'}</span>
                        {d.isOnline && <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">● Online</span>}
                      </div>
                      <div className="flex gap-3 mt-0.5">
                        {d.isActivated ? (
                          <>
                            {d.ipAddress && <span className="text-xs text-gray-400">IP: {d.ipAddress}</span>}
                            {d.version && <span className="text-xs text-gray-400">v{d.version}</span>}
                            {d.lastSeenAt && (
                              <span className="text-xs text-gray-400">
                                Ostatnio: {new Date(d.lastSeenAt).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })}
                              </span>
                            )}
                          </>
                        ) : d.activationCode ? (
                          <span className="text-xs text-amber-600 font-mono">Kod: {d.activationCode}</span>
                        ) : (
                          <span className="text-xs text-gray-400">Nieaktywne</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        if (!confirm(`Usunąć urządzenie "${d.name ?? d.id}"?`)) return
                        await api.delete(`/edge/devices/${d.id}`)
                        api.get(`/edge/buildings/${id}/devices`).then((r) => setEdgeDevices(r.data)).catch(() => {})
                      }}
                      className="text-xs text-red-400 hover:text-red-600 flex-shrink-0">🗑️</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Instrukcja */}
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">📋 Jak uruchomić GateLynk Edge?</h3>
            <ol className="text-xs text-gray-500 space-y-1.5 list-decimal list-inside">
              <li>Zainstaluj aplikację GateLynk Edge na urządzeniu (Mac Mini lub HP ZGX Nano)</li>
              <li>Uruchom aplikację — otworzy się lokalny panel na porcie <code className="bg-gray-200 px-1 rounded">4000</code></li>
              <li>Wejdź na <code className="bg-gray-200 px-1 rounded">http://&lt;IP urządzenia&gt;:4000/activation/status</code></li>
              <li>Wprowadź wygenerowany kod aktywacyjny (ważny 24h)</li>
              <li>Urządzenie połączy się z chmurą GateLynk i pojawi się jako Online</li>
            </ol>
          </div>
        </div>
      )}

      {/* ── MODAL: Reset hasła ────────────────────────────────────────────── */}
      {resetTarget && (
        <Modal onClose={() => setResetTarget(null)}>
          <h3 className="text-lg font-bold text-gray-900 mb-1">🔑 Resetuj hasło</h3>
          <p className="text-sm text-gray-500 mb-4">{resetTarget.name}</p>
          <form onSubmit={handleResetPassword} className="space-y-3">
            {resetError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-2">{resetError}</div>}
            <div>
              <label className="block text-xs text-gray-600 mb-1">Nowe hasło *</label>
              <input required type="password" minLength={8} value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="min. 8 znaków" className={inputCls} autoFocus />
            </div>
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={resetSaving}
                className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {resetSaving ? 'Zapisywanie...' : 'Zapisz nowe hasło'}
              </button>
              <button type="button" onClick={() => setResetTarget(null)}
                className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                Anuluj
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── MODAL: Ustawienia części wspólnej ─────────────────────────────── */}
      {settingsUnit && (
        <Modal onClose={() => setSettingsUnit(null)}>
          <h3 className="text-lg font-bold text-gray-900 mb-1">⚙️ Ustawienia rezerwacji</h3>
          <p className="text-sm text-gray-500 mb-4">{settingsUnit.unitType?.name} {settingsUnit.number}</p>
          <form onSubmit={handleSaveSettings} className="space-y-3">
            {sError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-2">{sError}</div>}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Maks. czas rezerwacji (min)</label>
                <input type="number" min="15" step="15" value={sMaxSlot} onChange={(e) => setSMaxSlot(e.target.value)}
                  className={inputCls} />
              </div>
              <div />
              <div>
                <label className="block text-xs text-gray-600 mb-1">Godziny otwarcia</label>
                <input type="time" value={sOpenTime} onChange={(e) => setSOpenTime(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Godziny zamknięcia</label>
                <input type="time" value={sCloseTime} onChange={(e) => setSCloseTime(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setSIsPaid(!sIsPaid)}
                className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border transition ${
                  sIsPaid ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-200 text-gray-500'
                }`}>
                <span className={`w-4 h-4 rounded-full border-2 ${sIsPaid ? 'bg-blue-500 border-blue-500' : 'border-gray-300'}`} />
                Płatna rezerwacja
              </button>
            </div>
            {sIsPaid && (
              <div>
                <label className="block text-xs text-gray-600 mb-1">Cena za godzinę (zł)</label>
                <input type="number" min="0" step="0.5" value={sPricePerHour} onChange={(e) => setSPricePerHour(e.target.value)}
                  placeholder="np. 50" className={inputCls} />
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
        </Modal>
      )}

      {/* ── MODAL: Archiwizacja ────────────────────────────────────────────── */}
      {showArchiveConfirm && (
        <Modal onClose={() => setShowArchiveConfirm(false)}>
          <div className="text-center">
            <div className="text-5xl mb-4">📦</div>
            <h3 className="text-lg font-bold text-gray-900 mb-2">Archiwizuj budynek?</h3>
            <p className="text-sm text-gray-500 mb-6">
              Budynek zostanie ukryty z listy aktywnych. Wszystkie dane pozostaną zachowane.
              Możesz go przywrócić w dowolnej chwili.
            </p>
            {actionError && <p className="text-sm text-red-600 mb-3">{actionError}</p>}
            <div className="flex gap-3">
              <button onClick={handleArchive} disabled={actionLoading}
                className="flex-1 bg-yellow-500 text-white text-sm font-medium py-2 rounded-lg hover:bg-yellow-600 disabled:opacity-50">
                {actionLoading ? 'Archiwizuję...' : 'Tak, archiwizuj'}
              </button>
              <button onClick={() => setShowArchiveConfirm(false)}
                className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">
                Anuluj
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── MODAL: Trwałe usunięcie ────────────────────────────────────────── */}
      {/* ── KARTA MIESZKAŃCA ──────────────────────────────────────────────── */}
      {selectedResident && (
        <Modal onClose={() => setSelectedResident(null)}>
          <div className="flex items-start justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-900">👤 {selectedResident.firstName} {selectedResident.lastName}</h2>
            {!rEditMode && (
              <button onClick={() => setREditMode(true)}
                className="text-sm text-blue-600 hover:text-blue-800 font-medium ml-4 flex-shrink-0">✏️ Edytuj</button>
            )}
          </div>
          {rEditMode ? (
            <form onSubmit={handleSaveResident} className="space-y-3">
              {rError && <ErrBanner msg={rError} />}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={teamLabelCls}>Imię *</label>
                  <input required value={rFirstName} onChange={(e) => setRFirstName(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={teamLabelCls}>Nazwisko *</label>
                  <input required value={rLastName} onChange={(e) => setRLastName(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={teamLabelCls}>Email *</label>
                  <input required type="email" value={rEmail} onChange={(e) => setREmail(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={teamLabelCls}>Telefon</label>
                  <input value={rPhone} onChange={(e) => setRPhone(e.target.value)} placeholder="np. +48 600 000 000" className={inputCls} />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={rSaving}
                  className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {rSaving ? 'Zapisywanie...' : 'Zapisz'}
                </button>
                <button type="button" onClick={() => setREditMode(false)}
                  className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                  Anuluj
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="text-sm space-y-1">
                <p className="text-gray-600">{selectedResident.email}</p>
                {selectedResident.phone && <p className="text-gray-500">{selectedResident.phone}</p>}
              </div>
              {selectedResident.unitResidents?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Lokale</p>
                  <div className="flex flex-wrap gap-2">
                    {selectedResident.unitResidents.filter((ur: any) => !ur.untilDate).map((ur: any) => (
                      <span key={ur.id} className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-1 rounded-full">
                        {ur.unit?.unitType?.name} {ur.unit?.number}
                        {ur.role === 'OWNER' ? ' (właściciel)' : ' (lokator)'}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(() => {
                const resVehicles = vehicles.filter((v) => v.residentId === selectedResident.id)
                return resVehicles.length > 0 ? (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Pojazdy</p>
                    <div className="space-y-1">
                      {resVehicles.map((v) => (
                        <div key={v.id} className="text-xs text-gray-700 bg-gray-50 rounded-lg px-3 py-2">
                          🚗 {v.make}{v.model ? ` ${v.model}` : ''} · <span className="font-mono">{v.licensePlate}</span> · {v.color}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null
              })()}
              {/* Wyślij wiadomość */}
              <div className="border-t border-gray-100 pt-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Wyślij wiadomość</p>
                <form onSubmit={handleSendResidentNotif} className="space-y-2">
                  {rNotifResult && (
                    <div className={`text-xs rounded-lg px-3 py-2 border ${
                      rNotifResult.startsWith('Błąd')
                        ? 'bg-red-50 border-red-200 text-red-700'
                        : 'bg-green-50 border-green-200 text-green-700'
                    }`}>{rNotifResult}</div>
                  )}
                  <input required value={rNotifTitle} onChange={(e) => setRNotifTitle(e.target.value)}
                    placeholder="Tytuł *" className={inputCls} />
                  <textarea required value={rNotifBody} onChange={(e) => setRNotifBody(e.target.value)}
                    placeholder="Treść wiadomości *" rows={3}
                    className={`${inputCls} resize-none`} />
                  <button type="submit" disabled={rNotifSending}
                    className="w-full bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                    {rNotifSending ? 'Wysyłanie...' : '🔔 Wyślij powiadomienie'}
                  </button>
                </form>
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* ── KARTA LOKALU ──────────────────────────────────────────────────── */}
      {selectedUnit && (
        <Modal onClose={() => setSelectedUnit(null)}>
          <div className="flex items-start justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-900">🚪 {selectedUnit.unitType?.name} {selectedUnit.number}</h2>
            {!uEditMode && (
              <button onClick={() => setUEditMode(true)}
                className="text-sm text-blue-600 hover:text-blue-800 font-medium ml-4 flex-shrink-0">✏️ Edytuj</button>
            )}
          </div>
          {uEditMode ? (
            <form onSubmit={handleSaveUnit} className="space-y-3">
              {uError && <ErrBanner msg={uError} />}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={teamLabelCls}>Numer / nazwa *</label>
                  <input required value={uNumber} onChange={(e) => setUNumber(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={teamLabelCls}>Piętro</label>
                  <input type="number" value={uFloor} onChange={(e) => setUFloor(e.target.value)} placeholder="np. 3" className={inputCls} />
                </div>
                <div>
                  <label className={teamLabelCls}>Typ lokalu *</label>
                  <select required value={uUnitTypeId} onChange={(e) => setUUnitTypeId(e.target.value)} className={inputCls}>
                    <option value="">— Wybierz —</option>
                    {unitTypes.filter((ut: any) => !ut.isCommonArea).map((ut: any) => (
                      <option key={ut.id} value={ut.id}>{ut.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={teamLabelCls}>Klatka schodowa</label>
                  <select value={uStairwellId} onChange={(e) => setUStairwellId(e.target.value)} className={inputCls}>
                    <option value="">— Brak —</option>
                    {building?.stairwells?.map((sw: any) => (
                      <option key={sw.id} value={sw.id}>{sw.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={uSaving}
                  className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {uSaving ? 'Zapisywanie...' : 'Zapisz'}
                </button>
                <button type="button" onClick={() => setUEditMode(false)}
                  className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
                  Anuluj
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="text-sm space-y-1 text-gray-600">
                {selectedUnit.floor != null && <p>Piętro: <span className="font-medium text-gray-900">{selectedUnit.floor}</span></p>}
                {selectedUnit.stairwell && <p>Klatka: <span className="font-medium text-gray-900">{selectedUnit.stairwell.name}</span></p>}
                {selectedUnit.areaSqm && <p>Powierzchnia: <span className="font-medium text-gray-900">{selectedUnit.areaSqm} m²</span></p>}
              </div>
              {uResidents.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Mieszkańcy</p>
                  <div className="space-y-1">
                    {uResidents.filter((ur: any) => !ur.untilDate).map((ur: any) => (
                      <div key={ur.id} className="text-xs text-gray-700 bg-gray-50 rounded-lg px-3 py-2">
                        👤 {ur.resident?.firstName} {ur.resident?.lastName}
                        <span className="ml-2 text-gray-400">{ur.role === 'OWNER' ? 'właściciel' : 'lokator'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {/* ── KARTA POJAZDU ─────────────────────────────────────────────────── */}
      {selectedVehicle && (
        <Modal onClose={() => setSelectedVehicle(null)}>
          <div className="flex items-start justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-900">🚗 {selectedVehicle.make}{selectedVehicle.model ? ` ${selectedVehicle.model}` : ''}</h2>
            {!veEditMode && (
              <button onClick={() => setVeEditMode(true)}
                className="text-sm text-blue-600 hover:text-blue-800 font-medium ml-4 flex-shrink-0">✏️ Edytuj</button>
            )}
          </div>
          {veEditMode ? (
            <form onSubmit={handleSaveVehicle} className="space-y-3">
              {veError && <ErrBanner msg={veError} />}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={teamLabelCls}>Marka *</label>
                  <input required value={veMake} onChange={(e) => setVeMake(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={teamLabelCls}>Model</label>
                  <input value={veModel} onChange={(e) => setVeModel(e.target.value)} placeholder="np. Corolla, 3 Series" className={inputCls} />
                </div>
                <div>
                  <label className={teamLabelCls}>Kolor *</label>
                  <input required value={veColor} onChange={(e) => setVeColor(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={teamLabelCls}>Nr rejestracyjny *</label>
                  <input required value={vePlate} onChange={(e) => setVePlate(e.target.value.toUpperCase())} className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className={teamLabelCls}>Mieszkaniec *</label>
                  <select required value={veResidentId} onChange={(e) => setVeResidentId(e.target.value)} className={inputCls}>
                    <option value="">— Wybierz —</option>
                    {residents.map((r: any) => (
                      <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex gap-2 pt-1">
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
          ) : (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-gray-50 rounded-lg px-3 py-2">
                  <p className="text-xs text-gray-500">Nr rejestracyjny</p>
                  <p className="font-mono font-semibold text-gray-900">{selectedVehicle.licensePlate}</p>
                </div>
                <div className="bg-gray-50 rounded-lg px-3 py-2">
                  <p className="text-xs text-gray-500">Kolor</p>
                  <p className="font-medium text-gray-900">{selectedVehicle.color}</p>
                </div>
              </div>
              {selectedVehicle.resident && (
                <div className="bg-blue-50 rounded-lg px-3 py-2">
                  <p className="text-xs text-blue-500 mb-0.5">Właściciel</p>
                  <p className="font-medium text-blue-800">👤 {selectedVehicle.resident.firstName} {selectedVehicle.resident.lastName}</p>
                </div>
              )}
              <button onClick={async () => {
                if (!confirm('Usunąć ten pojazd?')) return
                await api.delete(`/buildings/${id}/vehicles/${selectedVehicle.id}`)
                setSelectedVehicle(null)
                api.get(`/buildings/${id}/vehicles`).then((r) => setVehicles(r.data))
              }} className="w-full text-xs text-red-500 hover:text-red-700 border border-red-200 hover:border-red-300 rounded-lg py-1.5 transition">
                🗑️ Usuń pojazd
              </button>
            </div>
          )}
        </Modal>
      )}

      {showDeleteConfirm && (
        <Modal onClose={() => { setShowDeleteConfirm(false); setDeleteConfirmName(''); setActionError(null) }}>
          <div>
            <div className="text-center mb-4">
              <div className="text-5xl mb-3">⚠️</div>
              <h3 className="text-lg font-bold text-gray-900 mb-2">Trwałe usunięcie budynku</h3>
              <p className="text-sm text-gray-500">
                Ta operacja jest <strong>nieodwracalna</strong>. Zostaną usunięte wszystkie lokale,
                mieszkańcy, historia i powiadomienia.
              </p>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <p className="text-sm text-red-700">
                Aby potwierdzić, wpisz dokładną nazwę budynku:{' '}
                <strong>{building.name}</strong>
              </p>
            </div>
            <input type="text" value={deleteConfirmName}
              onChange={(e) => { setDeleteConfirmName(e.target.value); setActionError(null) }}
              placeholder="Wpisz nazwę budynku..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 mb-3" />
            {actionError && <p className="text-sm text-red-600 mb-3">{actionError}</p>}
            <div className="flex gap-3">
              <button onClick={handleDelete}
                disabled={actionLoading || deleteConfirmName !== building.name}
                className="flex-1 bg-red-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-red-700 disabled:opacity-40">
                {actionLoading ? 'Usuwanie...' : '🗑️ Usuń na zawsze'}
              </button>
              <button onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmName(''); setActionError(null) }}
                className="flex-1 border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50">
                Anuluj
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─── Stałe CSS ─────────────────────────────────────────────────────────────────
const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
const teamLabelCls = 'block text-xs text-gray-600 mb-1'

// ─── Komponenty formularza edycji ─────────────────────────────────────────────
function EditSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="font-semibold text-gray-800 mb-3">{title}</h3>
      {children}
    </div>
  )
}

function EditField({ label, colSpan, children }: { label: string; colSpan?: number; children: React.ReactNode }) {
  return (
    <div className={colSpan === 2 ? 'col-span-2' : ''}>
      <label className="block text-xs text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!value)}
      className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border transition ${
        value ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
      }`}>
      <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${
        value ? 'bg-blue-500 border-blue-500' : 'border-gray-300'
      }`} />
      {label}
    </button>
  )
}

// ─── Pomocnicze komponenty widoku ─────────────────────────────────────────────
function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="font-semibold text-gray-800 mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between text-sm py-0.5">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900">{value ?? <span className="text-gray-400 font-normal">—</span>}</span>
    </div>
  )
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        {children}
      </div>
    </div>
  )
}

function ErrBanner({ msg }: { msg: string }) {
  return <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-2">{msg}</div>
}

const vinp = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
const vlbl = 'block text-xs text-gray-600 mb-1'

// Faza 1 bety Villa Natura — vehicle approval flow.
// Status PENDING — zarejestrowany przez mieszkańca, czeka na decyzję
// APPROVED — aktywny, w allowliście LPR
// REJECTED — admin odmówił z powodem
// BLOCKED  — admin tymczasowo zablokował
// EXPIRED  — guest car po terminie validTo (faza 2)
type VehicleStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'BLOCKED' | 'EXPIRED'
type VehicleAction = 'approve' | 'reject' | 'block' | 'unblock'

const VEHICLE_STATUS_BADGE: Record<VehicleStatus, { label: string; cls: string; icon: string }> = {
  PENDING:  { label: 'Oczekuje',     cls: 'bg-orange-100 text-orange-700 border-orange-200', icon: '⏳' },
  APPROVED: { label: 'Aktywny',      cls: 'bg-green-100 text-green-700 border-green-200',    icon: '✅' },
  REJECTED: { label: 'Odrzucony',    cls: 'bg-red-100 text-red-700 border-red-200',          icon: '❌' },
  BLOCKED:  { label: 'Zablokowany',  cls: 'bg-gray-200 text-gray-700 border-gray-300',       icon: '🚫' },
  EXPIRED:  { label: 'Wygasł',       cls: 'bg-gray-100 text-gray-500 border-gray-200',       icon: '⌛' },
}

// Sortowanie: PENDING/BLOCKED na górze (admin musi szybko zareagować),
// reszta poniżej. Ten sam ranking co w iOS BAVehiclesView.
const STATUS_SORT_RANK: Record<VehicleStatus, number> = {
  PENDING: 0, BLOCKED: 1, APPROVED: 2, REJECTED: 3, EXPIRED: 4,
}

export function VehiclesTab({
  vehicles, residents, showAddVehicle, setShowAddVehicle,
  vResidentId, setVResidentId, vMake, setVMake, vModel, setVModel, vColor, setVColor, vPlate, setVPlate,
  vAdding, vError, onAdd, onDelete, onSelect, canEdit, onAction,
}: {
  vehicles: any[]; residents: any[]; showAddVehicle: boolean; setShowAddVehicle: (v: boolean) => void
  vResidentId: string; setVResidentId: (v: string) => void
  vMake: string; setVMake: (v: string) => void
  vModel: string; setVModel: (v: string) => void
  vColor: string; setVColor: (v: string) => void
  vPlate: string; setVPlate: (v: string) => void
  vAdding: boolean; vError: string | null
  onAdd: (e: React.FormEvent) => void
  onDelete: (vehicleId: number) => void
  onSelect?: (v: any) => void
  canEdit: boolean
  // Opcjonalne — gdy podane, pokazujemy przyciski approve/reject/block/unblock
  // i banner „X do zatwierdzenia" na górze. Integrator (`/dashboard/buildings`)
  // nie podaje tego propa, więc zachowuje stary widok read-only.
  onAction?: (vehicleId: number, action: VehicleAction, reason?: string) => Promise<void> | void
}) {
  // Posortowane lokalnie — PENDING/BLOCKED na górze. Backend zwraca w kolejności
  // createdAt DESC, więc sortujemy tu zamiast w API żeby nie psuć innych konsumentów.
  const sortedVehicles = React.useMemo(() => {
    return [...vehicles].sort((a, b) => {
      const sa = STATUS_SORT_RANK[(a.status ?? 'APPROVED') as VehicleStatus] ?? 99
      const sb = STATUS_SORT_RANK[(b.status ?? 'APPROVED') as VehicleStatus] ?? 99
      return sa - sb
    })
  }, [vehicles])

  const pendingCount = vehicles.filter(v => v.status === 'PENDING').length
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-gray-800">🚗 Pojazdy ({vehicles.length})</h2>
        {canEdit && !showAddVehicle && (
          <button onClick={() => setShowAddVehicle(true)}
            className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700">
            + Dodaj pojazd
          </button>
        )}
      </div>

      {canEdit && showAddVehicle && (
        <form onSubmit={onAdd} className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
          <h3 className="text-sm font-semibold text-blue-800">Nowy pojazd</h3>
          {vError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-2">{vError}</div>}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={vlbl}>Mieszkaniec *</label>
              <select required value={vResidentId} onChange={(e) => setVResidentId(e.target.value)} className={vinp}>
                <option value="">— Wybierz mieszkańca —</option>
                {residents.map((r: any) => (
                  <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={vlbl}>Marka *</label>
              <input required value={vMake} onChange={(e) => setVMake(e.target.value)}
                placeholder="np. Toyota, BMW" className={vinp} />
            </div>
            <div>
              <label className={vlbl}>Model</label>
              <input value={vModel} onChange={(e) => setVModel(e.target.value)}
                placeholder="np. Corolla, 3 Series" className={vinp} />
            </div>
            <div>
              <label className={vlbl}>Kolor *</label>
              <input required value={vColor} onChange={(e) => setVColor(e.target.value)}
                placeholder="np. Srebrny" className={vinp} />
            </div>
            <div>
              <label className={vlbl}>Numer rejestracyjny *</label>
              <input required value={vPlate} onChange={(e) => setVPlate(e.target.value.toUpperCase())}
                placeholder="np. WA12345" className={vinp} />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={vAdding}
              className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {vAdding ? 'Dodawanie...' : 'Dodaj pojazd'}
            </button>
            <button type="button" onClick={() => setShowAddVehicle(false)}
              className="flex-1 border border-gray-300 text-gray-700 text-sm py-2 rounded-lg hover:bg-gray-50">
              Anuluj
            </button>
          </div>
        </form>
      )}

      {/* Banner „X do zatwierdzenia" — tylko gdy admin ma akcje (onAction). */}
      {onAction && pendingCount > 0 && (
        <div className="mb-3 flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 text-sm">
          <span className="text-base">⏳</span>
          <span className="font-medium text-orange-800">
            {pendingCount === 1
              ? '1 pojazd oczekuje na zatwierdzenie'
              : `${pendingCount} pojazdów oczekuje na zatwierdzenie`}
          </span>
        </div>
      )}

      {vehicles.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">Brak zarejestrowanych pojazdów</p>
      ) : (
        <div className="divide-y divide-gray-100 -mx-5">
          {sortedVehicles.map((v: any) => {
            const status: VehicleStatus = (v.status ?? 'APPROVED') as VehicleStatus
            const badge = VEHICLE_STATUS_BADGE[status]
            return (
              <div key={v.id}
                onClick={() => onSelect?.(v)}
                className={`px-5 py-3 hover:bg-gray-50 ${onSelect ? 'cursor-pointer' : ''}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className="text-2xl">🚗</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {v.make}{v.model ? ` ${v.model}` : ''} · <span className="font-mono">{v.licensePlate}</span>
                      </p>
                      <p className="text-xs text-gray-400 truncate">
                        {v.color}
                        {v.resident && ` · ${v.resident.firstName} ${v.resident.lastName}`}
                        {v.kind && v.kind !== 'RESIDENT' && v.serviceName && ` · ${v.serviceName}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${badge.cls}`}>
                      <span>{badge.icon}</span>{badge.label}
                    </span>
                    {canEdit && !onSelect && (
                      <button onClick={(e) => { e.stopPropagation(); onDelete(v.id) }}
                        className="text-xs text-gray-400 hover:text-red-600">🗑️</button>
                    )}
                  </div>
                </div>
                {/* Powód odrzucenia — widoczny pod wierszem żeby admin wiedział kontekst. */}
                {status === 'REJECTED' && v.rejectionReason && (
                  <p className="mt-1 ml-9 text-xs text-red-600">Powód: {v.rejectionReason}</p>
                )}
                {/* Przyciski akcji — tylko gdy admin (onAction podany) i status pasuje. */}
                {onAction && (
                  <div className="mt-2 ml-9 flex gap-2" onClick={(e) => e.stopPropagation()}>
                    {status === 'PENDING' && (
                      <>
                        <button
                          onClick={() => onAction(v.id, 'approve')}
                          className="text-xs bg-green-600 text-white px-3 py-1 rounded-md hover:bg-green-700">
                          ✅ Zatwierdź
                        </button>
                        <button
                          onClick={() => {
                            const reason = window.prompt('Podaj powód odmowy (widoczny dla mieszkańca):')
                            if (reason && reason.trim()) onAction(v.id, 'reject', reason.trim())
                          }}
                          className="text-xs bg-white border border-red-300 text-red-700 px-3 py-1 rounded-md hover:bg-red-50">
                          ❌ Odrzuć
                        </button>
                      </>
                    )}
                    {status === 'APPROVED' && (
                      <button
                        onClick={() => {
                          if (window.confirm(`Zablokować pojazd ${v.licensePlate}? Zostanie usunięty z allowlisty LPR.`)) {
                            onAction(v.id, 'block')
                          }
                        }}
                        className="text-xs bg-white border border-gray-300 text-gray-700 px-3 py-1 rounded-md hover:bg-gray-50">
                        🚫 Zablokuj
                      </button>
                    )}
                    {status === 'BLOCKED' && (
                      <button
                        onClick={() => onAction(v.id, 'unblock')}
                        className="text-xs bg-green-600 text-white px-3 py-1 rounded-md hover:bg-green-700">
                        🔓 Odblokuj
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TeamRow({ name, email, createdAt, onReset, onDelete }: {
  name: string; email: string; createdAt: string
  onReset: () => void; onDelete: () => void
}) {
  return (
    <div className="px-5 py-3 flex items-center justify-between hover:bg-gray-50">
      <div>
        <p className="text-sm font-medium text-gray-900">{name}</p>
        <p className="text-xs text-gray-400">{email}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 mr-1">od {new Date(createdAt).toLocaleDateString('pl-PL')}</span>
        <button onClick={onReset}
          className="text-xs text-gray-400 hover:text-blue-600 transition px-2 py-1 rounded hover:bg-blue-50">
          🔑 Resetuj
        </button>
        <button onClick={onDelete}
          className="text-xs text-gray-400 hover:text-red-600 transition">
          🗑️
        </button>
      </div>
    </div>
  )
}

// ── Branding tab ─────────────────────────────────────────────────────────────

export function BrandingTab({ building, uploading, onUpload, onRemove }: {
  building: any
  uploading: 'logo' | 'bg' | null
  onUpload: (field: string, base64: string) => Promise<void>
  onRemove: (field: string) => Promise<void>
}) {
  const toBase64 = (file: File): Promise<string> =>
    new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result as string)
      r.onerror = rej
      r.readAsDataURL(file)
    })

  const handlePick = async (field: 'logoBase64' | 'backgroundImageBase64', maxMB: number) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/svg+xml'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      if (file.size > maxMB * 1024 * 1024) {
        alert(`Plik jest za duży. Maksymalny rozmiar: ${maxMB} MB.`)
        return
      }
      const base64 = await toBase64(file)
      await onUpload(field, base64)
    }
    input.click()
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Info */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-700">
        <p className="font-medium mb-1">🖼️ Branding obiektu</p>
        <p className="text-xs text-blue-600">Logo i zdjęcie tła będą wyświetlane w aplikacji mobilnej GateLynk dla mieszkańców tego obiektu.</p>
      </div>

      {/* Logo */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-900">Logo osiedla / zarządcy</h3>
            <p className="text-xs text-gray-400 mt-0.5">Zalecany format: PNG z przezroczystym tłem, maks. 500 KB. Pojawi się w nagłówku aplikacji mobilnej.</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handlePick('logoBase64', 1)}
              disabled={uploading === 'logo'}
              className="text-sm text-blue-600 border border-blue-300 px-3 py-1.5 rounded-lg hover:bg-blue-50 disabled:opacity-50 transition">
              {uploading === 'logo' ? '⏳ Wgrywanie...' : '⬆️ Wgraj logo'}
            </button>
            {building.logoBase64 && (
              <button onClick={() => onRemove('logoBase64')}
                className="text-sm text-gray-400 border border-gray-200 px-2 py-1.5 rounded-lg hover:text-red-500 hover:border-red-200 transition">
                🗑️
              </button>
            )}
          </div>
        </div>
        {building.logoBase64 ? (
          <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl border border-dashed border-gray-200">
            <img src={building.logoBase64} alt="Logo" className="h-20 max-w-[200px] object-contain" />
            <div className="text-xs text-gray-500">
              <p className="font-medium text-gray-700">Logo ustawione ✅</p>
              <p className="mt-0.5">Widoczne w aplikacji mobilnej</p>
            </div>
          </div>
        ) : (
          <div
            onClick={() => handlePick('logoBase64', 1)}
            className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition">
            <p className="text-3xl mb-2">🏷️</p>
            <p className="text-sm text-gray-500">Kliknij aby wgrać logo</p>
            <p className="text-xs text-gray-400 mt-1">PNG, JPG, WebP, SVG · maks. 1 MB</p>
          </div>
        )}
      </div>

      {/* Zdjęcie tła */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-900">Zdjęcie tła</h3>
            <p className="text-xs text-gray-400 mt-0.5">Zalecany format: JPG, min. 1280×720 px, maks. 3 MB. Wyświetlane jako tło w aplikacji mobilnej.</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handlePick('backgroundImageBase64', 3)}
              disabled={uploading === 'bg'}
              className="text-sm text-blue-600 border border-blue-300 px-3 py-1.5 rounded-lg hover:bg-blue-50 disabled:opacity-50 transition">
              {uploading === 'bg' ? '⏳ Wgrywanie...' : '⬆️ Wgraj zdjęcie'}
            </button>
            {building.backgroundImageBase64 && (
              <button onClick={() => onRemove('backgroundImageBase64')}
                className="text-sm text-gray-400 border border-gray-200 px-2 py-1.5 rounded-lg hover:text-red-500 hover:border-red-200 transition">
                🗑️
              </button>
            )}
          </div>
        </div>
        {building.backgroundImageBase64 ? (
          <div className="relative rounded-xl overflow-hidden border border-gray-200">
            <img src={building.backgroundImageBase64} alt="Tło" className="w-full h-48 object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent flex items-end p-3">
              <span className="text-white text-xs font-medium">✅ Zdjęcie tła ustawione</span>
            </div>
          </div>
        ) : (
          <div
            onClick={() => handlePick('backgroundImageBase64', 3)}
            className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition">
            <p className="text-3xl mb-2">🌄</p>
            <p className="text-sm text-gray-500">Kliknij aby wgrać zdjęcie tła</p>
            <p className="text-xs text-gray-400 mt-1">JPG, PNG, WebP · maks. 3 MB</p>
          </div>
        )}
      </div>
    </div>
  )
}
