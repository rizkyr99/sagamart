import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ProblemError, problem } from '@sagamart/node-common';
import type { Request, Response } from 'express';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';
import { Roles, identityOf } from '../identity.js';
import { Idempotency } from '../idempotency.js';
import type { StoredResponse } from '../idempotency.js';
import { parseIdempotencyKey, parseIfMatch, requestHash } from '../preconditions.js';
import { parse } from '../validation.js';
import {
  categoryCreate,
  categoryPatch,
  productCreate,
  productPatch,
  skuCreate,
  skuPatch,
} from './admin.schemas.js';
import { CatalogAdmin } from './catalog.admin.js';
import type { AdminProduct, AdminSku, Versioned } from './catalog.admin.js';
import type { Category } from './catalog.queries.js';
import { CursorError, cursorProblem, decodeCursor, encodeCursor } from './cursor.js';
import type { CursorPosition } from './cursor.js';

const listQuery = z.object({
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).nullable().default(null),
  limit: z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().min(1).max(50))
    .default(20),
  cursor: z.string().max(512).nullable().default(null),
});

const uuid = z.uuid();

/** A path id that isn't a UUID names nothing: 404, like any unknown id. */
function requireUuid(id: string, what: string): string {
  if (!uuid.safeParse(id).success) {
    throw new ProblemError(problem({ status: 404, code: 'NOT_FOUND', detail: `No such ${what}.` }));
  }
  return id;
}

const etag = (version: number): string => `"${String(version)}"`;

/** Sends a resource with its ETag; `status` is 200 unless given. */
function reply<T>(res: Response, { value, version }: Versioned<T>, status = 200): T {
  res.status(status).setHeader('ETag', etag(version));
  return value;
}

/** Admin writes: contracts/openapi/catalog-internal-v1.yaml, tag Admin. FR-11. */
@Controller('internal/v1/admin')
@Roles('admin')
export class AdminController {
  constructor(
    private readonly admin: CatalogAdmin,
    private readonly idempotency: Idempotency,
  ) {}

  /** Runs a create once per Idempotency-Key, replaying the stored status, body and ETag on retries. */
  private async once(
    req: Request,
    res: Response,
    work: (tx: EntityManager) => Promise<Versioned<unknown>>,
  ): Promise<unknown> {
    const owner = identityOf(req).sub;
    if (owner === undefined) {
      throw new ProblemError(
        problem({ status: 403, code: 'FORBIDDEN', detail: 'Admin writes need a user identity (sub).' }),
      );
    }
    const stored: StoredResponse = await this.idempotency.run(
      {
        owner,
        key: parseIdempotencyKey(req.header('idempotency-key')),
        hash: requestHash(req.method, req.originalUrl.split('?')[0] ?? '', req.body),
      },
      async (tx) => {
        const created = await work(tx);
        return { status: 201, body: created.value, etag: etag(created.version) };
      },
    );
    res.status(stored.status).setHeader('ETag', stored.etag);
    return stored.body;
  }

  // ---- Categories ----

  @Post('categories')
  async createCategory(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    parseIdempotencyKey(req.header('idempotency-key'));
    const input = parse(categoryCreate, body);
    return this.once(req, res, (tx) => this.admin.createCategory(tx, input));
  }

  @Patch('categories/:id')
  async updateCategory(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Category> {
    const version = parseIfMatch(ifMatch);
    const patch = parse(categoryPatch, body);
    return reply(res, await this.admin.updateCategory(requireUuid(id, 'category'), version, patch));
  }

  // ---- Products ----

  @Get('products')
  async products(@Query() raw: unknown): Promise<{ items: AdminProduct[]; nextCursor: string | null }> {
    const q = parse(listQuery, raw);
    const fingerprinted = { scope: 'admin', status: q.status };
    let after: CursorPosition | null = null;
    if (q.cursor !== null) {
      try {
        after = decodeCursor(q.cursor, fingerprinted, 'time');
      } catch (err) {
        if (err instanceof CursorError) throw cursorProblem(err);
        throw err;
      }
    }
    const rows = await this.admin.products({ status: q.status, after, limit: q.limit });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => r.product),
      nextCursor: rows.length > q.limit && last ? encodeCursor(fingerprinted, last.position) : null,
    };
  }

  @Post('products')
  async createProduct(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    parseIdempotencyKey(req.header('idempotency-key'));
    const input = parse(productCreate, body);
    return this.once(req, res, (tx) => this.admin.createProduct(tx, input));
  }

  @Get('products/:id')
  async product(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<AdminProduct> {
    const found = await this.admin.product(requireUuid(id, 'product'));
    if (!found)
      throw new ProblemError(problem({ status: 404, code: 'NOT_FOUND', detail: 'No such product.' }));
    return reply(res, found);
  }

  @Patch('products/:id')
  async updateProduct(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminProduct> {
    const version = parseIfMatch(ifMatch);
    const patch = parse(productPatch, body);
    return reply(res, await this.admin.updateProduct(requireUuid(id, 'product'), version, patch));
  }

  // ---- SKUs ----

  @Post('products/:id/skus')
  async addSku(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    const productId = requireUuid(id, 'product');
    parseIdempotencyKey(req.header('idempotency-key'));
    const input = parse(skuCreate, body);
    return this.once(req, res, (tx) => this.admin.addSku(tx, productId, input));
  }

  @Patch('skus/:sku')
  async updateSku(
    @Param('sku') sku: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminSku> {
    const version = parseIfMatch(ifMatch);
    const patch = parse(skuPatch, body);
    return reply(res, await this.admin.updateSku(sku, version, patch));
  }
}
