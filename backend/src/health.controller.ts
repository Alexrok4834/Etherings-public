import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  getHealth() {
    return {
      status: 'ok',
      service: 'etherings-mvp-backend',
      timestamp: new Date().toISOString(),
    };
  }
}
