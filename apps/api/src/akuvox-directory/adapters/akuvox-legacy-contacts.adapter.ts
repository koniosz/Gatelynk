/**
 * AkuvoxLegacyContactsAdapter — adapter dla STARSZYCH instalacji (pkt 5 spec):
 * firmware sprzed modelu Directory User (np. R29C 29.30.10.128, E18C).
 *
 * Format wyjściowy: UserData.tgz identyczny z eksportem urządzenia E18C —
 * jedyny format „builtin", bo został POTWIERDZONY SPRZĘTOWO (odtworzony 1:1
 * w legacy `IntercomAkuvoxExportService`, 2026-06-22). Ten adapter jest
 * następcą tamtego serwisu w architekturze v2 (analiza §1.3) — reużywa jego
 * tar-writer przez wspólny generator template-driven.
 *
 * Transport w Etapie 1: wyłącznie MANUAL (pobierz plik → import w web UI
 * urządzenia). applyDirectory/verifyDirectory przez sieć = Etap 3 (DEVICE_API,
 * po potwierdzeniu endpointów). ZERO żądań do fizycznych urządzeń.
 */
import {
  AkuvoxAdapter,
  AkuvoxCapabilities,
  AkuvoxDeviceInfo,
  AkuvoxDirectorySnapshot,
  AkuvoxDirectoryUser,
  ApplyResult,
  GeneratedImportFile,
  TemplateSpec,
  VerificationResult,
} from '../domain/directory.types'
import { detectCapabilitiesFromInfo } from './akuvox-capabilities'
import { generateFromSpec } from '../template/akuvox-file-generator'

/**
 * Builtin template — format E18C UserData.tgz potwierdzony na sprzęcie.
 * Odzwierciedla 1:1 strukturę z `IntercomAkuvoxExportService.buildUserDataXml`
 * (userdata.xml + DoorSchedule.xml, atrybuty i stałe jak w eksporcie E18C).
 */
export const BUILTIN_E18C_TEMPLATE: TemplateSpec = {
  format: 'tgz',
  encoding: 'utf-8',
  files: [
    {
      name: 'userdata.xml',
      kind: 'user-data',
      rootElement: 'UserData',
      recordElement: 'Data',
      attributes: [
        'ID',
        'UserID',
        'Name',
        'WebRelay',
        'Floor',
        'Phone',
        'Group',
        'PriorityOfCall',
        'DialAccount',
        'Schedule-Relay',
        'Schedule-SRelay',
      ],
      constants: {
        WebRelay: '0',
        Floor: '0',
        PriorityOfCall: '0',
        'Schedule-Relay': '1001-1;',
        'Schedule-SRelay': '',
      },
      childElements: ['Pin'],
    },
    {
      name: 'DoorSchedule.xml',
      kind: 'schedule',
      // 1:1 z eksportu urządzenia (por. DOOR_SCHEDULE_XML w legacy serwisie).
      verbatimContent:
        `<?xml version="1.0" encoding="UTF-8" ?>\n` +
        `<Schedule>\n` +
        `    <Data ID="1" ScheduleID="1001" Name="Always" Type="2" Date="" Weekly="" Daily="00:00-23:59" />\n` +
        `    <Data ID="2" ScheduleID="1002" Name="Never" Type="2" Date="" Weekly="" Daily="00:00-00:00" />\n` +
        `</Schedule>\n`,
    },
  ],
}

export const BUILTIN_E18C_TEMPLATE_SOURCE = 'builtin:e18c-userdata-tgz'

export class AkuvoxLegacyContactsAdapter implements AkuvoxAdapter {
  constructor(
    private readonly info: AkuvoxDeviceInfo,
    private readonly snapshot: AkuvoxDirectorySnapshot,
    /** Opcjonalny template wgrany z urządzenia — ma pierwszeństwo nad builtin. */
    private readonly uploadedTemplate?: { spec: TemplateSpec; source: string } | null,
  ) {}

  async detectCapabilities(): Promise<AkuvoxCapabilities> {
    return detectCapabilitiesFromInfo(this.info)
  }

  /** Etap 1: „eksport" = ostatni snapshot wgrany przez instalatora (widok E). */
  async exportCurrentDirectory(): Promise<AkuvoxDirectorySnapshot> {
    return this.snapshot
  }

  async generateImportFile(users: AkuvoxDirectoryUser[]): Promise<GeneratedImportFile> {
    const tpl = this.uploadedTemplate ?? { spec: BUILTIN_E18C_TEMPLATE, source: BUILTIN_E18C_TEMPLATE_SOURCE }
    return generateFromSpec(users, tpl.spec, { fileName: 'UserData.tgz', templateSource: tpl.source })
  }

  async applyDirectory(_file: GeneratedImportFile): Promise<ApplyResult> {
    return {
      ok: false,
      message:
        'Tryb MANUAL: import wykonuje instalator w web UI urządzenia (Directory → User → Import). Automatyczny zapis = Etap 3 (DEVICE_API).',
    }
  }

  async verifyDirectory(): Promise<VerificationResult> {
    return {
      ok: false,
      message: 'Weryfikacja automatyczna niedostępna w trybie ręcznym — porównaj ekran urządzenia z podglądem (widok C).',
    }
  }
}
