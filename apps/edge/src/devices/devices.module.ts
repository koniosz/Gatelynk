import { Module } from '@nestjs/common'
import { DeviceRegistryService } from './device-registry.service'
import { DevicesController } from './devices.controller'
import { IntercomService } from './intercom/intercom.service'
import { IntercomPinService } from './intercom/intercom-pin.service'
import { IntercomCallService } from './intercom/intercom-call.service'
import { AkuvoxEventController } from './intercom/akuvox-event.controller'
import { IntercomSnapshotController } from './intercom/intercom-snapshot.controller'
import { CamerasService } from './cameras/cameras.service'
import { HikvisionLprService } from './cameras/hikvision-lpr.service'
import { LprAlertStreamService } from './cameras/lpr-alertstream.service'
import { LprEventsController } from './cameras/lpr-events.controller'
import { LprAdminController } from './cameras/lpr-admin.controller'
import { VisionDetectService } from './cameras/vision-detect.service'
import { VisionDetectController } from './cameras/vision-detect.controller'
import { VisionLlmSummarizerService } from './cameras/vision-llm-summarizer.service'
import { SituationCorrelatorService } from './cameras/situation-correlator.service'
import { SituationsController } from './situations.controller'
import { AiEngineController } from './cameras/ai-engine.controller'
import { ElevatorService } from './elevator/elevator.service'
import { LightingService } from './lighting/lighting.service'
import { LanSwitchService } from './lan-switch/lan-switch.service'
import { LanSwitchController } from './lan-switch/lan-switch.controller'
import { SmartLockService } from './smart-lock/smart-lock.service'

@Module({
  controllers: [
    DevicesController,
    LprEventsController,
    LprAdminController,
    AkuvoxEventController,
    IntercomSnapshotController,
    LanSwitchController,
    VisionDetectController,
    SituationsController,
    AiEngineController,
  ],
  providers: [
    DeviceRegistryService,
    IntercomService,
    IntercomPinService,
    IntercomCallService,
    CamerasService,
    HikvisionLprService,
    LprAlertStreamService,
    VisionDetectService,
    // 2026-05-22: cron co 30s generujący LLM summary dla notable frames.
    // Działa background-side — VisionDetectService dalej inseruje rows
    // synchronicznie, ten worker tylko async wypełnia llm_summary.
    VisionLlmSummarizerService,
    // 2026-08-26: korelator zdarzeń sytuacyjnych — tick co 60 s skleja klatki
    // wizji + odczyty LPR w zdarzenia (tailgating, krążący pojazd, osoba
    // w nocy, wizyta kuriera, upadek). Zapisuje do situation_events.
    SituationCorrelatorService,
    ElevatorService,
    LightingService,
    LanSwitchService,
    SmartLockService,
  ],
  exports: [
    DeviceRegistryService,
    HikvisionLprService,
    IntercomPinService,
    IntercomService,                 // 2026-06-01 — AccessPointsModule.OutputDriverRegistry potrzebuje (Akuvox driver)
    IntercomCallService,             // 2026-06-13 — TunnelService injectuje (CMD INTERCOM_CALL_* + setTunnelSend/bootstrap)
    LanSwitchService,
    SmartLockService,                // 2026-07-08 — AccessPointsModule.OutputDriverRegistry (driver NUKI; pułapka #8: MUSI być w exports)
    VisionDetectService,
    VisionLlmSummarizerService,      // 2026-06-08 — TunnelService potrzebuje LLM_TEST handler
  ],
})
export class DevicesModule {}
