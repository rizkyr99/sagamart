import { fileURLToPath } from 'node:url';
import { bundle, createConfig } from '@redocly/openapi-core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
// CommonJS under NodeNext: the default import is the whole module, and the plugin is its `default`.
import formats from 'ajv-formats';

interface Operation {
  responses?: Record<string, { content?: Record<string, { schema?: object }> }>;
}
type PathItem = Partial<Record<string, Operation>>;

/** Checks response bodies against one of contracts/openapi's specs, with every $ref resolved. */
export class Contract {
  private readonly validators = new Map<string, ValidateFunction>();

  private constructor(
    private readonly paths: Record<string, PathItem>,
    private readonly ajv: Ajv2020,
  ) {}

  static async load(spec: string): Promise<Contract> {
    const ref = fileURLToPath(new URL(`../../../../contracts/openapi/${spec}`, import.meta.url));
    const { bundle: doc, problems } = await bundle({
      ref,
      config: await createConfig({}),
      dereference: true,
    });
    if (problems.length > 0) throw new Error(`cannot bundle ${spec}: ${problems[0]?.message ?? ''}`);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    formats.default(ajv);
    ajv.addFormat('int64', true);
    return new Contract((doc.parsed as { paths: Record<string, PathItem> }).paths, ajv);
  }

  private compile(key: string, method: string, path: string, status: number): ValidateFunction {
    const response = this.paths[path]?.[method.toLowerCase()]?.responses?.[String(status)];
    const schema = Object.values(response?.content ?? {})[0]?.schema;
    if (!schema) throw new Error(`the contract has no ${key} response with a body`);
    const validate = this.ajv.compile(schema);
    this.validators.set(key, validate);
    return validate;
  }

  /** Validation errors of `body` as the `status` response of `method` `path` (the spec's template); [] if valid. */
  errors(method: string, path: string, status: number, body: unknown): string[] {
    const key = `${method} ${path} ${String(status)}`;
    const validate = this.validators.get(key) ?? this.compile(key, method, path, status);
    return validate(body)
      ? []
      : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
  }
}
