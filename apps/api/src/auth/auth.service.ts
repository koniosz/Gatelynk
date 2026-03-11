import { Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PrismaService } from '../prisma/prisma.service'
import * as bcrypt from 'bcryptjs'

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async validateAdmin(email: string, password: string) {
    const admin = await this.prisma.admin.findUnique({ where: { email } })
    if (!admin) throw new UnauthorizedException('Nieprawidłowy email lub hasło')

    const valid = await bcrypt.compare(password, admin.passwordHash)
    if (!valid) throw new UnauthorizedException('Nieprawidłowy email lub hasło')

    return admin
  }

  async login(admin: { id: number; email: string; name: string }) {
    return {
      accessToken: this.jwt.sign({ sub: admin.id, email: admin.email }),
      admin: { id: admin.id, email: admin.email, name: admin.name },
    }
  }

  async register(data: { email: string; password: string; name: string }) {
    const exists = await this.prisma.admin.findUnique({ where: { email: data.email } })
    if (exists) throw new UnauthorizedException('Email jest już zajęty')

    const passwordHash = await bcrypt.hash(data.password, 12)
    const admin = await this.prisma.admin.create({
      data: { email: data.email, passwordHash, name: data.name },
    })

    return this.login(admin)
  }
}
