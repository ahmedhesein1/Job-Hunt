import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TABLE_SCHEMA } from './helpers';

/** Guards against the DynamoDB Local schema drifting from template.yaml. */
describe('integration table mirrors template.yaml', () => {
  const template = readFileSync(join(__dirname, '..', '..', 'template.yaml'), 'utf8');

  it('has the same GSIs and GSI1 projection', () => {
    const gsi1 = TABLE_SCHEMA.GlobalSecondaryIndexes[0];
    const match = /NonKeyAttributes:\s*\[([^\]]+)\]/.exec(template);
    expect(match).not.toBeNull();
    const fromTemplate = match![1]!.split(',').map((s) => s.trim()).filter(Boolean);
    expect([...gsi1.Projection.NonKeyAttributes].sort()).toEqual(fromTemplate.sort());
    expect(template).toMatch(/IndexName: GSI2[\s\S]*?ProjectionType: KEYS_ONLY/);
    expect(template).toMatch(/StreamViewType: NEW_IMAGE/);
  });
});
