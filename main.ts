// Driver for the markdown-render-speed-02 entry.
// Reads cases from <input>/cases.json and writes the rendered HTML
// strings, in input order, to <output>/html.json.
// Input/output dirs: /input and /output inside the grading container;
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override them locally.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = cases.map((c) => parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
