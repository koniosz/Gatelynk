import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { LicenseService } from '../license/license.service'
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'
import { sortUnits } from '../common/natural-sort'

export class StairwellDto {
  @IsString() name: string
}

export class RelayDto {
  @IsString() id: string
  @IsString() label: string
}

export class StairwellIntercomDto {
  // Legacy pola — nadal akceptowane dla starych klientów (Akuvox-only forma):
  @IsOptional() @IsString() manufacturer?: string
  @IsOptional() @IsString() model?: string
  @IsOptional() @IsString() ipAddress?: string
  @IsOptional() @IsString() login?: string
  @IsOptional() @IsString() password?: string
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RelayDto)
  relays?: RelayDto[]

  // Nowy uniwersalny model — driverId z katalogu + cały config jako blob:
  @IsOptional() @IsString() driverId?: string
  @IsOptional() config?: Record<string, unknown>
}

export class CreateLprCameraDto {
  @IsString() name: string
  @IsString() manufacturer: string
  @IsOptional() @IsString() model?: string
  @IsOptional() @IsString() ipAddress?: string
  @IsOptional() @IsString() login?: string
  @IsOptional() @IsString() password?: string
  // Edge owns the whitelist and triggers gate opening via the linked intercom relay.
  @IsOptional() @IsString() linkedIntercomEdgeId?: string
  @IsOptional() @IsInt() linkedRelayIndex?: number
}

export class CreateVehicleDto {
  // 2026-09-07: mieszkaniec LUB lokal (co najmniej jedno z dwóch).
  @IsOptional() @IsInt() residentId?: number
  @IsOptional() @IsInt() unitId?: number
  @IsString() make: string
  @IsOptional() @IsString() model?: string
  @IsString() color: string
  @IsString() licensePlate: string
}

export class UpdateVehicleDto {
  @IsOptional() @IsInt() residentId?: number
  @IsOptional() @IsInt() unitId?: number
  @IsOptional() @IsString() make?: string
  @IsOptional() @IsString() model?: string
  @IsOptional() @IsString() color?: string
  @IsOptional() @IsString() licensePlate?: string
}

export class UpdateLprCameraDto {
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsString() manufacturer?: string
  @IsOptional() @IsString() model?: string
  @IsOptional() @IsString() ipAddress?: string
  @IsOptional() @IsString() login?: string
  @IsOptional() @IsString() password?: string
  @IsOptional() @IsString() linkedIntercomEdgeId?: string
  @IsOptional() @IsInt() linkedRelayIndex?: number
}

export class CreateBuildingIntercomDto {
  @IsString() name: string
  @IsOptional() @IsString() model?: string
}

export class UpdateBuildingIntercomDto {
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsString() model?: string
  @IsOptional() @IsString() ipAddress?: string
  @IsOptional() @IsString() sipServer?: string
  @IsOptional() @IsString() sipAccount?: string
  @IsOptional() @IsString() sipPassword?: string
}

export class CreateIntegratorDto {
  @IsString() name: string
  @IsString() email: string
  @IsString() password: string
}

export class CreateBuildingAdminDto {
  @IsString() name: string
  @IsString() email: string
  @IsString() password: string
  @IsArray() @IsInt({ each: true }) buildingIds: number[]
}

export class CreateConciergeDto {
  @IsString() name: string
  @IsString() email: string
  @IsString() password: string
  @IsInt() buildingId: number
}

export class CreateBuildingDto {
  @IsOptional() @IsString() objectType?: string // BUILDING | PARKING
  @IsString() name: string
  @IsString() address: string
  @IsOptional() @IsString() nip?: string
  @IsOptional() @IsString() regon?: string

  // Parametry ogólne
  @IsOptional() @IsInt() @Min(0) numberOfFloors?: number
  @IsOptional() @IsInt() @Min(0) numberOfHouses?: number
  @IsOptional() @IsBoolean() hasElevator?: boolean
  @IsOptional() @IsBoolean() hasCctv?: boolean
  @IsOptional() @IsBoolean() hasLightingControl?: boolean
  @IsOptional() @IsBoolean() hasEdgeAI?: boolean
  @IsOptional() @IsBoolean() hasEdge?: boolean
  @IsOptional() @IsBoolean() hasPhotovoltaics?: boolean

  // Udogodnienia
  @IsOptional() @IsBoolean() hasPool?: boolean
  @IsOptional() @IsBoolean() hasGym?: boolean
  @IsOptional() @IsBoolean() hasSauna?: boolean
  @IsOptional() @IsBoolean() hasPlayroom?: boolean
  @IsOptional() @IsBoolean() hasBanquetHall?: boolean
  @IsOptional() @IsBoolean() hasLobby?: boolean

  // Domofon
  @IsOptional() @IsBoolean() hasIntercom?: boolean
  @IsOptional() @IsString() intercomManufacturer?: string
  @IsOptional() @IsString() intercomModel?: string
  @IsOptional() @IsInt() @Min(0) entranceCount?: number

  // LPR
  @IsOptional() @IsBoolean() hasLprSystem?: boolean
  @IsOptional() @IsString() lprManufacturer?: string
  @IsOptional() @IsString() lprModel?: string

  // Paczki
  @IsOptional() @IsString() packageHandling?: string

  // Klatki schodowe
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => StairwellDto)
  stairwells?: StairwellDto[]
}

export class UpdateBuildingDto {
  @IsOptional() @IsString() objectType?: string
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsString() address?: string
  @IsOptional() @IsString() nip?: string
  @IsOptional() @IsString() regon?: string
  @IsOptional() @IsInt() @Min(0) numberOfFloors?: number
  @IsOptional() @IsInt() @Min(0) numberOfHouses?: number
  @IsOptional() @IsBoolean() hasElevator?: boolean
  @IsOptional() @IsBoolean() hasCctv?: boolean
  @IsOptional() @IsBoolean() hasLightingControl?: boolean
  @IsOptional() @IsBoolean() hasEdgeAI?: boolean
  @IsOptional() @IsBoolean() hasEdge?: boolean
  @IsOptional() @IsBoolean() hasPhotovoltaics?: boolean
  @IsOptional() @IsBoolean() hasPool?: boolean
  @IsOptional() @IsBoolean() hasGym?: boolean
  @IsOptional() @IsBoolean() hasSauna?: boolean
  @IsOptional() @IsBoolean() hasPlayroom?: boolean
  @IsOptional() @IsBoolean() hasBanquetHall?: boolean
  @IsOptional() @IsBoolean() hasLobby?: boolean
  @IsOptional() @IsBoolean() hasIntercom?: boolean
  @IsOptional() @IsString() intercomManufacturer?: string
  @IsOptional() @IsString() intercomModel?: string
  @IsOptional() @IsInt() @Min(0) entranceCount?: number
  @IsOptional() @IsBoolean() hasLprSystem?: boolean
  @IsOptional() @IsString() lprManufacturer?: string
  @IsOptional() @IsString() lprModel?: string
  @IsOptional() @IsString() packageHandling?: string
  @IsOptional() @IsString() logoBase64?: string
  @IsOptional() @IsString() backgroundImageBase64?: string
}

@Injectable()
export class BuildingsService {
  constructor(
    private prisma: PrismaService,
    private licenseService: LicenseService,
  ) {}

  async findAll(adminId: number, includeArchived = false) {
    return this.prisma.building.findMany({
      where: {
        adminId,
        ...(includeArchived ? {} : { isArchived: false }),
      },
      include: {
        stairwells: { orderBy: { createdAt: 'asc' } },
        _count: { select: { units: true, residents: true } },
      },
      orderBy: [{ isArchived: 'asc' }, { createdAt: 'asc' }],
    })
  }

  async findOne(id: number, adminId: number) {
    const building = await this.prisma.building.findFirst({
      where: { id, adminId },
      include: { stairwells: { orderBy: { createdAt: 'asc' }, include: { intercom: true } } },
    })
    if (!building) throw new NotFoundException('Budynek nie istnieje')
    return building
  }

  async create(adminId: number, dto: CreateBuildingDto) {
    await this.licenseService.checkLimit(adminId, 'buildings')
    const { stairwells, ...buildingData } = dto
    return this.prisma.building.create({
      data: {
        ...buildingData,
        adminId,
        stairwells: stairwells?.length
          ? { create: stairwells.map((s) => ({ name: s.name })) }
          : undefined,
      },
      include: { stairwells: true },
    })
  }

  async update(id: number, adminId: number, dto: UpdateBuildingDto) {
    const building = await this.findOne(id, adminId)
    const updated = await this.prisma.building.update({
      where: { id },
      data: dto,
      include: { stairwells: { orderBy: { createdAt: 'asc' } } },
    })

    // ── Auto-tworzenie części wspólnych z udogodnień ────────────────────────
    // Mapowanie flagi udogodnienia → kod systemowego UnitType
    const amenityMap: { flag: keyof UpdateBuildingDto; code: string; name: string }[] = [
      { flag: 'hasPool',        code: 'pool',         name: 'Basen' },
      { flag: 'hasGym',         code: 'gym',          name: 'Siłownia' },
      { flag: 'hasSauna',       code: 'sauna',        name: 'Sauna' },
      { flag: 'hasPlayroom',    code: 'playroom',     name: 'Sala zabaw' },
      { flag: 'hasBanquetHall', code: 'banquet_hall', name: 'Sala bankietowa' },
    ]

    for (const { flag, code, name } of amenityMap) {
      // Flaga zmieniona na true w tym wywołaniu (lub wcześniej nie była true)
      const nowEnabled = dto[flag] === true
      const wasEnabled = building[flag as keyof typeof building] === true
      if (!nowEnabled || wasEnabled) continue  // interesuje nas tylko nowe włączenie

      // Znajdź systemowy typ części wspólnej
      const unitType = await this.prisma.unitType.findFirst({
        where: { isSystem: true, code, isCommonArea: true },
      })
      if (!unitType) continue

      // Sprawdź czy lokal tego typu w tym budynku już istnieje
      const existing = await this.prisma.unit.findFirst({
        where: { buildingId: id, unitTypeId: unitType.id },
      })
      if (existing) continue

      // Utwórz lokal
      await this.prisma.unit.create({
        data: { buildingId: id, unitTypeId: unitType.id, number: name },
      })
    }

    return updated
  }

  async archive(id: number, adminId: number) {
    await this.findOne(id, adminId)
    return this.prisma.building.update({
      where: { id },
      data: { isArchived: true, archivedAt: new Date() },
    })
  }

  async unarchive(id: number, adminId: number) {
    await this.findOne(id, adminId)
    return this.prisma.building.update({
      where: { id },
      data: { isArchived: false, archivedAt: null },
    })
  }

  async remove(id: number, adminId: number, confirmName: string) {
    const building = await this.findOne(id, adminId)
    if (building.name !== confirmName) {
      throw new BadRequestException(
        'Nazwa budynku nie pasuje. Wpisz dokładną nazwę, aby potwierdzić usunięcie.',
      )
    }

    // Znajdź adminów budynku przypisanych TYLKO do tego budynku (staną się osieroceni)
    const orphanedAdmins = await this.prisma.buildingAdmin.findMany({
      where: {
        adminId,
        buildings: { every: { buildingId: id } },
        AND: { buildings: { some: { buildingId: id } } },
      },
      select: { id: true },
    })
    const orphanedAdminIds = orphanedAdmins.map((a) => a.id)

    // Usuń kaskadowo powiązane dane
    await this.prisma.$transaction([
      // Replies do zgłoszeń
      this.prisma.ticketReply.deleteMany({ where: { ticket: { buildingId: id } } }),
      // Zgłoszenia
      this.prisma.ticket.deleteMany({ where: { buildingId: id } }),
      // Powiadomienia push
      this.prisma.pushToken.deleteMany({ where: { resident: { buildingId: id } } }),
      // Powiadomienia in-app
      this.prisma.notification.deleteMany({ where: { buildingId: id } }),
      // Rezerwacje
      this.prisma.reservation.deleteMany({ where: { buildingId: id } }),
      // Paczki
      this.prisma.parcel.deleteMany({ where: { buildingId: id } }),
      // Pojazdy
      this.prisma.vehicle.deleteMany({ where: { buildingId: id } }),
      // Zaproszenia
      this.prisma.invitation.deleteMany({ where: { unit: { buildingId: id } } }),
      // Przypisania mieszkańców do lokali
      this.prisma.unitResident.deleteMany({ where: { unit: { buildingId: id } } }),
      // Ustawienia części wspólnych
      this.prisma.commonAreaSettings.deleteMany({ where: { unit: { buildingId: id } } }),
      // Lokale
      this.prisma.unit.deleteMany({ where: { buildingId: id } }),
      // Mieszkańcy
      this.prisma.resident.deleteMany({ where: { buildingId: id } }),
      // Kamery LPR
      this.prisma.lprCamera.deleteMany({ where: { buildingId: id } }),
      this.prisma.buildingIntercom.deleteMany({ where: { buildingId: id } }),
      // Domofony (cascade z klatek)
      this.prisma.stairwellIntercom.deleteMany({ where: { stairwell: { buildingId: id } } }),
      // Klatki schodowe
      this.prisma.stairwell.deleteMany({ where: { buildingId: id } }),
      // Typy lokali
      this.prisma.unitType.deleteMany({ where: { buildingId: id, isSystem: false } }),
      // Przypisania adminów budynku
      this.prisma.buildingAdminAssignment.deleteMany({ where: { buildingId: id } }),
      // Konta adminów budynku, które nie mają innych budynków (osierocone)
      ...(orphanedAdminIds.length > 0
        ? [this.prisma.buildingAdmin.deleteMany({ where: { id: { in: orphanedAdminIds } } })]
        : []),
      // Portierzy
      this.prisma.concierge.deleteMany({ where: { buildingId: id } }),
      // Budynek
      this.prisma.building.delete({ where: { id } }),
    ])
    return { deleted: true }
  }

  // Zarządzanie klatkami schodowymi
  async addStairwell(buildingId: number, adminId: number, name: string) {
    await this.findOne(buildingId, adminId)
    return this.prisma.stairwell.create({ data: { buildingId, name } })
  }

  async updateStairwell(
    buildingId: number,
    stairwellId: number,
    adminId: number,
    name: string,
  ) {
    await this.findOne(buildingId, adminId)
    return this.prisma.stairwell.update({
      where: { id: stairwellId },
      data: { name },
    })
  }

  async removeStairwell(
    buildingId: number,
    stairwellId: number,
    adminId: number,
  ) {
    await this.findOne(buildingId, adminId)
    return this.prisma.stairwell.delete({ where: { id: stairwellId } })
  }

  // ── Klatki schodowe — szczegóły ────────────────────────────────────────────
  async getStairwellDetail(buildingId: number, stairwellId: number, adminId: number) {
    await this.findOne(buildingId, adminId)
    const sw = await this.prisma.stairwell.findFirst({
      where: { id: stairwellId, buildingId },
      include: {
        intercom: true,
        units: { include: { unitType: true }, orderBy: { number: 'asc' } },
      },
    })
    if (!sw) throw new NotFoundException('Klatka nie istnieje')
    sortUnits(sw.units)
    return sw
  }

  // ── Domofony klatek ────────────────────────────────────────────────────────
  /**
   * Zapis konfiguracji domofonu klatki — wspiera dwa formaty wejścia:
   *
   *   • Legacy: { ipAddress, login, password, model, relays } — używany przez
   *     stary formularz Akuvoxa.
   *   • Driver-based: { driverId, config: { ... } } — używany przez nowy
   *     dynamiczny `DeviceConfigForm`. Pełen blob parametrów leci do `config`,
   *     a my dodatkowo zsynchronizujemy „kanoniczne" pola (ipAddress/login/...)
   *     do dedykowanych kolumn — żeby istniejące widoki czytające bezpośrednio
   *     z `intercom.ipAddress` (Edge sync, integrator panel) nadal działały.
   */
  async upsertStairwellIntercom(
    buildingId: number,
    stairwellId: number,
    adminId: number,
    dto: StairwellIntercomDto,
  ) {
    await this.findOne(buildingId, adminId)
    const stairwell = await this.prisma.stairwell.findFirst({
      where: { id: stairwellId, buildingId },
    })
    if (!stairwell) throw new NotFoundException('Klatka nie istnieje')

    // Krok 1: scal legacy fields z config blob — config wygrywa nad legacy,
    // bo nowy formularz wpisuje wartości tam. Zachowujemy starą formę dla
    // klientów którzy jeszcze nie znają drivera.
    const cfg = (dto.config ?? {}) as Record<string, unknown>
    const merged = {
      manufacturer: dto.manufacturer ?? (typeof cfg.manufacturer === 'string' ? cfg.manufacturer : undefined) ?? 'Akuvox',
      model:        dto.model        ?? (typeof cfg.model        === 'string' ? cfg.model        : undefined) ?? null,
      ipAddress:    dto.ipAddress    ?? (typeof cfg.ipAddress    === 'string' ? cfg.ipAddress    : undefined) ?? null,
      login:        dto.login        ?? (typeof cfg.login        === 'string' ? cfg.login        : undefined) ?? null,
      password:     dto.password     ?? (typeof cfg.password     === 'string' ? cfg.password     : undefined) ?? null,
      relays:       dto.relays       ?? (Array.isArray(cfg.relays) ? cfg.relays : undefined) ?? null,
    }

    // Krok 2: upsert „klasycznych" kolumn przez Prisma (zna te pola).
    await this.prisma.stairwellIntercom.upsert({
      where: { stairwellId },
      create: {
        stairwellId,
        manufacturer: merged.manufacturer,
        model:        merged.model,
        ipAddress:    merged.ipAddress,
        login:        merged.login,
        password:     merged.password,
        relays:       merged.relays as any,
      },
      update: {
        manufacturer: merged.manufacturer,
        model:        merged.model,
        ipAddress:    merged.ipAddress,
        login:        merged.login,
        password:     merged.password,
        relays:       merged.relays as any,
      },
    })

    // Krok 3: zapisz `driverId` + `config` osobno przez raw SQL — Prisma 7.5
    // w monorepo nie regeneruje typów (patrz CLAUDE.md, znany problem).
    if (dto.driverId !== undefined || dto.config !== undefined) {
      const configJson = dto.config !== undefined ? JSON.stringify(dto.config) : null
      await this.prisma.$executeRaw`
        UPDATE stairwell_intercoms
        SET "driverId" = ${dto.driverId ?? null},
            config     = ${configJson}::jsonb
        WHERE "stairwellId" = ${stairwellId}
      `
    }

    // Zwracamy pełen wiersz (włączając driverId/config) raw query'm, bo Prisma
    // nie wie o tych kolumnach.
    const [row] = await this.prisma.$queryRaw<any[]>`
      SELECT id, "stairwellId", manufacturer, model, "ipAddress", login, password,
             relays, "driverId", config, "updatedAt"
      FROM stairwell_intercoms
      WHERE "stairwellId" = ${stairwellId}
    `
    return row
  }

  // ── Kamery LPR ────────────────────────────────────────────────────────────
  async getLprCameras(buildingId: number, adminId: number) {
    await this.findOne(buildingId, adminId)
    return this.prisma.lprCamera.findMany({
      where: { buildingId },
      orderBy: { id: 'asc' },
    })
  }

  async createLprCamera(buildingId: number, adminId: number, dto: CreateLprCameraDto) {
    await this.findOne(buildingId, adminId)
    return this.prisma.lprCamera.create({ data: { ...dto, buildingId } })
  }

  async updateLprCamera(
    buildingId: number,
    cameraId: number,
    adminId: number,
    dto: UpdateLprCameraDto,
  ) {
    await this.findOne(buildingId, adminId)
    const cam = await this.prisma.lprCamera.findFirst({ where: { id: cameraId, buildingId } })
    if (!cam) throw new NotFoundException('Kamera nie istnieje')
    return this.prisma.lprCamera.update({ where: { id: cameraId }, data: dto })
  }

  async deleteLprCamera(buildingId: number, cameraId: number, adminId: number) {
    await this.findOne(buildingId, adminId)
    const cam = await this.prisma.lprCamera.findFirst({ where: { id: cameraId, buildingId } })
    if (!cam) throw new NotFoundException('Kamera nie istnieje')
    return this.prisma.lprCamera.delete({ where: { id: cameraId } })
  }

  // ── Domofony budynku ─────────────────────────────────────────────────────────
  async getIntercoms(buildingId: number, adminId: number) {
    await this.findOne(buildingId, adminId)
    return this.prisma.buildingIntercom.findMany({
      where: { buildingId },
      orderBy: { createdAt: 'asc' },
    })
  }

  async createIntercom(buildingId: number, adminId: number, dto: CreateBuildingIntercomDto) {
    await this.findOne(buildingId, adminId)
    return this.prisma.buildingIntercom.create({ data: { ...dto, buildingId } })
  }

  async updateIntercom(buildingId: number, intercomId: number, adminId: number, dto: UpdateBuildingIntercomDto) {
    await this.findOne(buildingId, adminId)
    const intercom = await this.prisma.buildingIntercom.findFirst({ where: { id: intercomId, buildingId } })
    if (!intercom) throw new NotFoundException('Domofon nie istnieje')
    return this.prisma.buildingIntercom.update({ where: { id: intercomId }, data: dto })
  }

  async deleteIntercom(buildingId: number, intercomId: number, adminId: number) {
    await this.findOne(buildingId, adminId)
    const intercom = await this.prisma.buildingIntercom.findFirst({ where: { id: intercomId, buildingId } })
    if (!intercom) throw new NotFoundException('Domofon nie istnieje')
    return this.prisma.buildingIntercom.delete({ where: { id: intercomId } })
  }

  // ── Integratorzy ──────────────────────────────────────────────────────────
  async getIntegrators(adminId: number) {
    return this.prisma.integrator.findMany({
      where: { adminId },
      select: { id: true, name: true, email: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
  }

  async createIntegrator(adminId: number, dto: CreateIntegratorDto) {
    const bcrypt = await import('bcrypt')
    const passwordHash = await bcrypt.hash(dto.password, 10)
    try {
      return await this.prisma.integrator.create({
        data: { adminId, name: dto.name, email: dto.email, passwordHash },
        select: { id: true, name: true, email: true, createdAt: true },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException('Konto z tym adresem email już istnieje')
      }
      throw err
    }
  }

  async deleteIntegrator(adminId: number, integratorId: number) {
    const integrator = await this.prisma.integrator.findFirst({
      where: { id: integratorId, adminId },
    })
    if (!integrator) throw new NotFoundException('Integrator nie istnieje')
    await this.prisma.integrator.delete({ where: { id: integratorId } })
    return { deleted: true }
  }

  // ── Administratorzy budynków ──────────────────────────────────────────────
  async getBuildingAdmins(adminId: number) {
    return this.prisma.buildingAdmin.findMany({
      where: { adminId },
      select: {
        id: true, name: true, email: true, createdAt: true,
        buildings: { select: { building: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async createBuildingAdmin(adminId: number, dto: CreateBuildingAdminDto) {
    const bcrypt = await import('bcrypt')
    const passwordHash = await bcrypt.hash(dto.password, 10)
    try {
      return await this.prisma.buildingAdmin.create({
        data: {
          adminId,
          name: dto.name,
          email: dto.email,
          passwordHash,
          buildings: {
            create: dto.buildingIds.map((buildingId) => ({ buildingId })),
          },
        },
        select: {
          id: true, name: true, email: true, createdAt: true,
          buildings: { select: { building: { select: { id: true, name: true } } } },
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException('Konto z tym adresem email już istnieje')
      }
      throw err
    }
  }

  async deleteBuildingAdmin(adminId: number, buildingAdminId: number) {
    const ba = await this.prisma.buildingAdmin.findFirst({
      where: { id: buildingAdminId, adminId },
    })
    if (!ba) throw new NotFoundException('Administrator budynku nie istnieje')
    await this.prisma.buildingAdmin.delete({ where: { id: buildingAdminId } })
    return { deleted: true }
  }

  // ── Konsjerże ─────────────────────────────────────────────────────────────
  async getConcierges(adminId: number) {
    return this.prisma.concierge.findMany({
      where: { adminId },
      select: {
        id: true, name: true, email: true, createdAt: true,
        building: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async createConcierge(adminId: number, dto: CreateConciergeDto) {
    const bcrypt = await import('bcrypt')
    const passwordHash = await bcrypt.hash(dto.password, 10)
    try {
      return await this.prisma.concierge.create({
        data: { adminId, name: dto.name, email: dto.email, passwordHash, buildingId: dto.buildingId },
        select: {
          id: true, name: true, email: true, createdAt: true,
          building: { select: { id: true, name: true } },
        },
      })
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException('Konto z tym adresem email już istnieje')
      }
      throw err
    }
  }

  async deleteConcierge(adminId: number, conciergeId: number) {
    const c = await this.prisma.concierge.findFirst({
      where: { id: conciergeId, adminId },
    })
    if (!c) throw new NotFoundException('Konsjerż nie istnieje')
    await this.prisma.concierge.delete({ where: { id: conciergeId } })
    return { deleted: true }
  }

  // ── Reset haseł ────────────────────────────────────────────────────────────
  async resetIntegratorPassword(adminId: number, id: number, newPassword: string) {
    const rec = await this.prisma.integrator.findFirst({ where: { id, adminId } })
    if (!rec) throw new NotFoundException('Integrator nie istnieje')
    const bcrypt = await import('bcrypt')
    const passwordHash = await bcrypt.hash(newPassword, 10)
    await this.prisma.integrator.update({ where: { id }, data: { passwordHash } })
    return { ok: true }
  }

  async resetBuildingAdminPassword(adminId: number, id: number, newPassword: string) {
    const rec = await this.prisma.buildingAdmin.findFirst({ where: { id, adminId } })
    if (!rec) throw new NotFoundException('Administrator budynku nie istnieje')
    const bcrypt = await import('bcrypt')
    const passwordHash = await bcrypt.hash(newPassword, 10)
    await this.prisma.buildingAdmin.update({ where: { id }, data: { passwordHash } })
    return { ok: true }
  }

  async resetConciergePassword(adminId: number, id: number, newPassword: string) {
    const rec = await this.prisma.concierge.findFirst({ where: { id, adminId } })
    if (!rec) throw new NotFoundException('Konsjerż nie istnieje')
    const bcrypt = await import('bcrypt')
    const passwordHash = await bcrypt.hash(newPassword, 10)
    await this.prisma.concierge.update({ where: { id }, data: { passwordHash } })
    return { ok: true }
  }

  // ── Pojazdy ────────────────────────────────────────────────────────────────
  async getVehicles(buildingId: number, adminId: number) {
    const building = await this.prisma.building.findFirst({ where: { id: buildingId, adminId } })
    if (!building) throw new NotFoundException('Budynek nie istnieje')
    return this.prisma.vehicle.findMany({
      where: { buildingId },
      include: { resident: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    })
  }

  async createVehicle(buildingId: number, adminId: number, dto: CreateVehicleDto) {
    const building = await this.prisma.building.findFirst({ where: { id: buildingId, adminId } })
    if (!building) throw new NotFoundException('Budynek nie istnieje')
    if (!dto.residentId && !dto.unitId) throw new BadRequestException('Wskaż mieszkańca lub lokal')
    if (dto.residentId) {
      const resident = await this.prisma.resident.findFirst({ where: { id: dto.residentId, buildingId } })
      if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    }
    if (dto.unitId) {
      const unit = await this.prisma.unit.findFirst({ where: { id: dto.unitId, buildingId } })
      if (!unit) throw new NotFoundException('Lokal nie istnieje')
    }
    return this.prisma.vehicle.create({
      data: {
        buildingId,
        residentId: dto.residentId ?? null,
        unitId: dto.unitId ?? null,
        make: dto.make, model: dto.model, color: dto.color, licensePlate: dto.licensePlate,
      },
      include: {
        resident: { select: { id: true, firstName: true, lastName: true } },
        unit: { select: { id: true, number: true } },
      },
    })
  }

  async updateVehicle(buildingId: number, vehicleId: number, adminId: number, dto: UpdateVehicleDto) {
    const building = await this.prisma.building.findFirst({ where: { id: buildingId, adminId } })
    if (!building) throw new NotFoundException('Budynek nie istnieje')
    const vehicle = await this.prisma.vehicle.findFirst({ where: { id: vehicleId, buildingId } })
    if (!vehicle) throw new NotFoundException('Pojazd nie istnieje')
    if (dto.unitId) {
      const unit = await this.prisma.unit.findFirst({ where: { id: dto.unitId, buildingId } })
      if (!unit) throw new NotFoundException('Lokal nie istnieje')
    }
    return this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: dto,
      include: {
        resident: { select: { id: true, firstName: true, lastName: true } },
        unit: { select: { id: true, number: true } },
      },
    })
  }

  async deleteVehicle(buildingId: number, vehicleId: number, adminId: number) {
    const building = await this.prisma.building.findFirst({ where: { id: buildingId, adminId } })
    if (!building) throw new NotFoundException('Budynek nie istnieje')
    const vehicle = await this.prisma.vehicle.findFirst({ where: { id: vehicleId, buildingId } })
    if (!vehicle) throw new NotFoundException('Pojazd nie istnieje')
    return this.prisma.vehicle.delete({ where: { id: vehicleId } })
  }
}
