// markdown-flash batch driver.
//
// Reads every case from <inputDir>/cases.json, renders each case's markdown
// on its own with parse(), and writes the resulting HTML strings, in input
// order, as a JSON array to <outputDir>/html.json.
//
// Directories come from the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// environment variables and default to /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const raw = readFileSync(join(inputDir, "cases.json"), "utf8");
const cases = JSON.parse(raw);

const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
