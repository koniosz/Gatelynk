import { Body, Controller, Get, Post, Request, UseGuards } from '@nestjs/common'
import { LicenseService } from './license.service'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { IsString, Matches } from 'class-validator'

class ActivateLicenseDto {
  @IsString()
  @Matches(/^GL-(STRT|STND|PRO_)-[A-Z0-9]{4}-[A-Z0-9]{4}-\d{4}$/, {
    message: 'Nieprawidłowy format klucza licencyjnego',
  })
  key: string
}

class GenerateKeyDto {
  @IsString() planCode: string
  validDays?: number
}

@Controller('license')
export class LicenseController {
  constructor(private licenseService: LicenseService) {}

  @UseGuards(JwtAuthGuard)
  @Post('activate')
  activate(@Body() dto: ActivateLicenseDto, @Request() req: any) {
    return this.licenseService.activate(dto.key, req.user.id)
  }

  @UseGuards(JwtAuthGuard)
  @Get('my')
  getMyLicense(@Request() req: any) {
    return this.licenseService.getMyLicense(req.user.id)
  }

  // Internal/admin endpoint - w produkcji zabezpieczone osobnym kluczem API
  @Post('generate')
  generateKey(@Body() dto: GenerateKeyDto) {
    return this.licenseService.generateKey(dto.planCode, dto.validDays)
  }
}
