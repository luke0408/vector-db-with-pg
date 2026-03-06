import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { PrismaModule } from './prisma/prisma.module'
import { QueryEmbeddingService } from './query-embedding.service'

@Module({
  imports: [
    PrismaModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  singleLine: true,
                  translateTime: 'SYS:standard'
                }
              }
      }
    })
  ],
  controllers: [AppController],
  providers: [AppService, QueryEmbeddingService]
})
export class AppModule {}
