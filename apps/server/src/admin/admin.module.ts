import { Module } from '@nestjs/common'
import { AdminController } from './admin.controller'
import { AdminService } from './admin.service'
import { LocalAdminGuard } from './admin-local.guard'

@Module({
  controllers: [AdminController],
  providers: [AdminService, LocalAdminGuard],
  exports: [AdminService]
})
export class AdminModule {}
