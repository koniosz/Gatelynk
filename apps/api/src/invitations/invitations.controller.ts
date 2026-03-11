import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { InvitationsService } from './invitations.service'
import { IsInt } from 'class-validator'

class SendInvitationDto {
  @IsInt() residentId: number
  @IsInt() unitId: number
}

@Controller('invitations')
export class InvitationsController {
  constructor(private invitationsService: InvitationsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('send')
  send(@Body() dto: SendInvitationDto, @Request() req: any) {
    // buildingId resolved from unit ownership in service
    return this.invitationsService.send(0, dto.residentId, dto.unitId, req.user.id)
  }

  @UseGuards(JwtAuthGuard)
  @Post('buildings/:buildingId/send')
  sendForBuilding(
    @Param('buildingId') buildingId: string,
    @Body() dto: SendInvitationDto,
    @Request() req: any,
  ) {
    return this.invitationsService.send(+buildingId, dto.residentId, dto.unitId, req.user.id)
  }

  @UseGuards(JwtAuthGuard)
  @Get('buildings/:buildingId')
  findAll(@Param('buildingId') buildingId: string) {
    return this.invitationsService.findAll(+buildingId)
  }

  // Public endpoint - accept invitation via token from email
  @Post('accept')
  accept(@Query('token') token: string) {
    return this.invitationsService.accept(token)
  }
}
