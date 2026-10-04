import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { DataIssue } from '../data/loader.ts';
import { FRAGMENTS_FILE } from './paths.ts';
import { parseFragments, type FragmentPools } from './template.ts';

export function loadFragments(file: string = FRAGMENTS_FILE): { pools: FragmentPools; issues: DataIssue[] } {
  const parsed = parseFragments(parseYaml(readFileSync(file, 'utf8')));
  return {
    pools: parsed.pools,
    issues: parsed.issues.map((message) => ({ file, level: 'error' as const, message })),
  };
}
