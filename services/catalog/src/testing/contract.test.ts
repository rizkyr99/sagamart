import { describe, expect, it } from 'vitest';
import { Contract } from './contract.js';

describe('Contract', () => {
  it('passes a body that matches the spec and names what is wrong with one that does not', async () => {
    const contract = await Contract.load('catalog-internal-v1.yaml');
    const category = {
      id: '0199f2d0-1a2b-7c3d-8e4f-5a6b7c8d9e01',
      slug: 'kaos',
      name: 'Kaos',
      parentId: null,
      position: 0,
    };
    expect(contract.errors('GET', '/internal/v1/categories', 200, { items: [category] })).toEqual([]);
    expect(
      contract.errors('GET', '/internal/v1/categories', 200, {
        items: [{ ...category, slug: 'Not A Slug' }],
      }),
    ).toEqual([expect.stringContaining('/items/0/slug')]);
    // $refs into the shared components resolve too: Problem Details from common-v1.yaml.
    expect(contract.errors('GET', '/internal/v1/products', 400, { status: 400 })).not.toEqual([]);
  });

  it('refuses to check a response the spec does not define', async () => {
    const contract = await Contract.load('catalog-internal-v1.yaml');
    expect(() => contract.errors('GET', '/internal/v1/categories', 418, {})).toThrow(/no GET/);
  });
});
