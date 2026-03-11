import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { AuthService } from './auth.service'
import { IsEmail, IsString, MinLength } from 'class-validator'

class RegisterDto {
  @IsEmail() email: string
  @IsString() name: string
  @IsString() @MinLength(8) password: string
}

class LoginDto {
  @IsEmail() email: string
  @IsString() password: string
}

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto)
  }

  @UseGuards(AuthGuard('local'))
  @Post('login')
  login(@Request() req: any) {
    return this.authService.login(req.user)
  }
}
