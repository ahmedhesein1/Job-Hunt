import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '..', 'fixtures');

export function fixtureText(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

export function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}
