import { Test } from '@nestjs/testing'
import { AppController } from '../src/app.controller'
import { AppService } from '../src/app.service'

describe('AppController', () => {
  it('returns health payload', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService]
    }).compile()

    const controller = moduleRef.get(AppController)
    expect(controller.health()).toEqual({
      success: true,
      data: {
        status: 'ok',
        service: 'vector-search-server'
      }
    })
  })
})
