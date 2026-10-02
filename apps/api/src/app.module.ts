import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ScheduleModule } from '@nestjs/schedule'
import * as Joi from 'joi'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { PrismaModule } from './prisma/prisma.module'
import { AuthModule } from './auth/auth.module'
import { LicenseModule } from './license/license.module'
import { BuildingsModule } from './buildings/buildings.module'
import { UnitsModule } from './units/units.module'
import { ResidentsModule } from './residents/residents.module'
import { InvitationsModule } from './invitations/invitations.module'
import { NotificationsModule } from './notifications/notifications.module'
import { SearchModule } from './search/search.module'
import { IntegratorModule } from './integrator/integrator.module'
import { BuildingAdminModule } from './building-admin/building-admin.module'
import { ConciergeModule } from './concierge/concierge.module'
import { MailModule } from './mail/mail.module'
import { MonitoringModule } from './monitoring/monitoring.module'
import { ResidentModule } from './resident/resident.module'
import { EdgeModule } from './edge/edge.module'
import { LprReadsModule } from './lpr-reads/lpr-reads.module'
import { GuestsModule } from './guests/guests.module'
import { GuestPortalModule } from './guest-portal/guest-portal.module'
import { InviteModule } from './invite/invite.module'
import { AccessEventsModule } from './access-events/access-events.module'
import { BuildingKnowledgeModule } from './building-knowledge/building-knowledge.module'
import { AnomalyEventsModule } from './anomaly-events/anomaly-events.module'
import { ResidentsImportModule } from './residents-import/residents-import.module'
import { AkuvoxDirectoryModule } from './akuvox-directory/akuvox-directory.module'
import { EstateMapModule } from './estate-map/estate-map.module'
import { WasteTruckModule } from './waste-truck/waste-truck.module'

@Module({
  imports: [
    // Schema validation: aplikacja NIE wstaje, jeśli któryś z `required` env
    // vars nie jest ustawiony. Zapobiega klasie błędów typu „API działa, ale
    // tokeny są podpisywane defaultem/undefined". Brak/krótki sekret → crash
    // na starcie z czytelnym błędem zamiast cichego dryfu w runtime.
    //
    // Optional vary (np. APN_*) trzymamy z `optional()` — APN to tylko push
    // notyfikacje na iOS, deploy bez nich jest dozwolony (np. dev w Dockerze).
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),
        // W dev wystarczy 16+ znaków, na prod (NODE_ENV=production) wymuszamy
        // 32+. To kompromis między „dev .env powinien po prostu działać"
        // a „prod nie może chodzić ze słabym sekretem".
        JWT_SECRET: Joi.string()
          .min(process.env.NODE_ENV === 'production' ? 32 : 16)
          .required()
          .messages({
            'string.min': process.env.NODE_ENV === 'production'
              ? 'JWT_SECRET na produkcji musi mieć ≥32 znaki — wygeneruj `openssl rand -hex 32`'
              : 'JWT_SECRET musi mieć ≥16 znaków',
            'any.required': 'JWT_SECRET nie ustawiony — patrz apps/api/.env.example',
          }),
        JWT_EXPIRES_IN: Joi.string().default('7d'),
        FRONTEND_URL: Joi.string().uri().required(),
        PORT: Joi.number().port().default(3000),
        // Mail (.allow('') bo docker-compose przekazuje puste env vars
        // z .env nawet gdy klucz jest niewypełniony — Joi default optional()
        // odrzuca empty string i powoduje restart loop API w dev).
        RESEND_API_KEY: Joi.string().allow('').optional(),
        // Bazowy URL portalu gościa (gatelynk.com w prod, localhost:3002 w dev).
        // MailService doczepia `/g/<token>`. Default: `https://gatelynk.com`.
        GUEST_PORTAL_BASE_URL: Joi.string().uri().allow('').optional(),
        // APN (iOS push) — opcjonalne, ten sam problem co wyżej.
        APN_KEY_ID: Joi.string().allow('').optional(),
        APN_TEAM_ID: Joi.string().allow('').optional(),
        APN_KEY_PATH: Joi.string().allow('').optional(),
        APN_BUNDLE_ID: Joi.string().allow('').optional(),
        // Dev-only: gdy API żyje w Dockerze, host musi być nazwą rozwiązywaną
        // wewnątrz kontenera (np. `host.docker.internal`) zamiast `172.18.0.1`
        // wykrywanego z WS upgrade. Patrz EdgeGateway.handleConnection.
        EDGE_HTTP_HOST_OVERRIDE: Joi.string().allow('').optional(),
      }),
      validationOptions: {
        abortEarly: false,    // pokaż wszystkie błędy naraz, nie po kolei
        allowUnknown: true,   // dodatkowe env vars (NODE_ENV itp.) są OK
      },
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    LicenseModule,
    BuildingsModule,
    UnitsModule,
    ResidentsModule,
    InvitationsModule,
    NotificationsModule,
    SearchModule,
    IntegratorModule,
    BuildingAdminModule,
    ConciergeModule,
    MailModule,
    MonitoringModule,
    ResidentModule,
    EdgeModule,
    LprReadsModule,
    GuestsModule,
    GuestPortalModule,
    InviteModule,
    AccessEventsModule,
    BuildingKnowledgeModule,
    AnomalyEventsModule,
    ResidentsImportModule,
    // Akuvox Directory Sync v2 (2026-07-30) — docs/akuvox-directory-v2-analysis.md.
    // Feature flags: AKUVOX_DIRECTORY_V2 / AKUVOX_MANUAL_IMPORT /
    // AKUVOX_PROVISIONING_SYNC / AKUVOX_DIRECTORY_WRITE_API (defaulty w
    // AkuvoxDirectoryConfigService); AKUVOX_CRED_KEY = klucz AES-256-GCM.
    AkuvoxDirectoryModule,
    // Mapa osiedla (2026-09-08) — render + przypisania miejsc na mapie do lokali.
    EstateMapModule,
    WasteTruckModule,
  ],
  // AppController wystawia `/api/health` (Fly health check oczekuje 200 — bez
  // tego Fly proxy zwraca [PR01] na zewnątrz i sygnatura z `flyctl checks list`
  // to „connect: connection refused" mimo że Nest faktycznie nasłuchuje).
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
