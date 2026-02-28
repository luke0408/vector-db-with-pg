import { Injectable } from '@nestjs/common'

@Injectable()
export class AppService {
  health() {
    return {
      success: true,
      data: {
        status: 'ok',
        service: 'vector-search-server'
      }
    }
  }
}
