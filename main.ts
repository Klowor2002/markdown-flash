// FlashMark driver: render every case in the input set with parse() and
// write the HTML strings, in case order, as one JSON array.
//
// Input:  <MAKEFUN_INPUT_DIR>/cases.json  — a JSON array of cases, each
//         with a `markdown` string. MAKEFUN_INPUT_DIR defaults to /input.
// Output: <MAKEFUN_OUTPUT_DIR>/html.json  — the rendered HTML strings in
//         the same order. MAKEFUN_OUTPUT_DIR defaults to /output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
