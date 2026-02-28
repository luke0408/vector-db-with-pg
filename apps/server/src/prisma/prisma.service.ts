import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {}
  }

  const content = readFileSync(filePath, 'utf-8')
  const entries: Record<string, string> = {}

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf('=')

    if (separatorIndex < 1) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    let value = line.slice(separatorIndex + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    entries[key] = value
  }

  return entries
}

function loadEnvCandidates(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), 'apps/server/.env'),
    resolve(process.cwd(), '../.env'),
    resolve(process.cwd(), '../../.env')
  ]

  for (const candidate of candidates) {
    const loaded = parseEnvFile(candidate)

    for (const [key, value] of Object.entries(loaded)) {
      if (process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  }
}

function pickEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]

    if (value && value.trim().length > 0) {
      return value.trim()
    }
  }

  return undefined
}

function hasUnresolvedPlaceholders(value: string): boolean {
  return /(POSTGRES_(USER|PASSWORD|DB)|PG(USER|PASSWORD|DATABASE|HOST|PORT))/i.test(
    value
  )
}

function resolveDatabaseUrl(): string {
  loadEnvCandidates()

  const explicitUrl = process.env.DATABASE_URL?.trim()

  if (explicitUrl && !hasUnresolvedPlaceholders(explicitUrl)) {
    return explicitUrl
  }

  const host = pickEnv('PGHOST', 'POSTGRES_HOST') ?? 'localhost'
  const port = pickEnv('PGPORT', 'POSTGRES_PORT') ?? '5432'
  const user = pickEnv('PGUSER', 'POSTGRES_USER') ?? 'postgres'
  const password = pickEnv('PGPASSWORD', 'POSTGRES_PASSWORD') ?? 'postgres'
  const database = pickEnv('PGDATABASE', 'POSTGRES_DB') ?? user

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password
  )}@${host}:${port}/${encodeURIComponent(database)}?schema=public`
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const databaseUrl = resolveDatabaseUrl()
    process.env.DATABASE_URL = databaseUrl

    super({
      datasources: {
        db: {
          url: databaseUrl
        }
      }
    })
  }

  async onModuleInit(): Promise<void> {
    await this.$connect()
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
