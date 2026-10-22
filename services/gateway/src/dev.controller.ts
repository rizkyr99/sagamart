import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import type { GatewayConfig } from './config.js';
import { ROLES, issueDevToken } from './dev-auth.js';
import { GATEWAY_CONFIG } from './tokens.js';
import { parse } from './validation.js';

const devTokenRequest = z.strictObject({ role: z.enum(ROLES), userId: z.uuid() });

/** POST /v1/dev/token (contracts: issueDevToken). Registered only when GATEWAY_DEV_AUTH is true; never in prod. */
@Controller('v1/dev')
export class DevController {
  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  @Post('token')
  @HttpCode(200)
  async token(@Body() body: unknown): Promise<{ token: string; expiresAt: string }> {
    const { role, userId } = parse(devTokenRequest, body ?? {});
    const secret = this.config.devAuth.secret;
    if (secret === undefined) throw new Error('DevController is registered without a dev JWT secret');
    return issueDevToken({ secret, userId, role });
  }
}
