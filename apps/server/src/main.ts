import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true
  })
  app.useLogger(app.get(Logger))
  app.enableCors()
  app.enableShutdownHooks()
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000)
}

bootstrap()
