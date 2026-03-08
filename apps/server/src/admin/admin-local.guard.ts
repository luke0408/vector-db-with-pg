import {
  CanActivate,
  ExecutionContext,
  Injectable
} from '@nestjs/common'
import type { Request } from 'express'

@Injectable()
export class LocalAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if ((process.env.ADMIN_ALLOW_REMOTE ?? '').toLowerCase() === 'true') {
      return true
    }

    const request = context.switchToHttp().getRequest<Request>()
    const remoteAddress = request.ip ?? request.socket?.remoteAddress ?? ''
    const hostname = request.hostname ?? ''

    return this.isLocalHostname(hostname) || this.isLocalAddress(remoteAddress)
  }

  private isLocalHostname(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase()
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
  }

  private isLocalAddress(address: string): boolean {
    const normalized = address.trim().toLowerCase()
    return (
      normalized === '127.0.0.1' ||
      normalized === '::1' ||
      normalized === '::ffff:127.0.0.1' ||
      normalized.startsWith('::ffff:127.')
    )
  }
}
