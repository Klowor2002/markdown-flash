// FlashMark driver: reads the competition cases, renders each one with
// parse.js, and writes the HTML array. Run as `node main.ts` (Node 22
// strips the types natively). The input and output directories default to
// /input and /output; the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// environment variables override them for local runs.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Array<{ id: string; markdown: string }>;
if (!Array.isArray(cases)) throw new Error('cases.json must contain an array');

const out: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  const md = cases[i]!.markdown;
  // tolerate a missing or non-string markdown field rather than
  // crashing the whole run; valid competition input always has one
  out[i] = parse(typeof md === 'string' ? md : '');
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
