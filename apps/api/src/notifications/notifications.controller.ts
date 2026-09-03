import { Body, Controller, Get, Param, Post, Request, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { NotificationsService, SendNotificationDto } from './notifications.service'

@UseGuards(JwtAuthGuard)
@Controller('buildings/:buildingId/notifications')
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Post()
  send(
    @Param('buildingId') buildingId: string,
    @Body() dto: SendNotificationDto,
    @Request() req: any,
  ) {
    return this.notificationsService.send(+buildingId, req.user.id, dto)
  }

  @Get()
  findAll(@Param('buildingId') buildingId: string, @Request() req: any) {
    return this.notificationsService.findAll(+buildingId, req.user.id)
  }

  @Get('resident/:residentId')
  findByResident(
    @Param('buildingId') buildingId: string,
    @Param('residentId') residentId: string,
    @Request() req: any,
  ) {
    return this.notificationsService.findByResident(+buildingId, +residentId, req.user.id)
  }
}
