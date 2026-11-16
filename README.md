# FlashMark

[![make.fun](https://img.shields.io/badge/make.fun-markdown--render--speed--02-blue)](https://make.fun/bounty/markdown-render-speed-02)
[![referral](https://img.shields.io/badge/referral-5svq4vk4-green)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, fast Markdown renderer whose `parse(markdown)` returns
byte-for-byte the HTML that **marked 18.1.3** renders with its defaults
(GFM on, breaks off). Built for the make.fun competition
[markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02).

## What it does

- `parse.js` — an ES module exporting `parse(markdown)`. It implements the
  CommonMark 0.31.2 block and inline rules plus the GFM 0.29 extensions
  (tables, task lists, strikethrough, extended autolinks, disallowed raw
  HTML) the way marked renders them, including marked's edge cases: tab
  handling in indented code, lazy continuation lines, setext headings,
  link reference definitions (first definition wins, forward references),
  and marked's emphasis fallback for odd delimiter runs.
- `main.ts` — the driver the harness runs: it reads every case from
  `/input/cases.json`, renders each one alone with `parse`, and writes the
  HTML array to `/output/html.json`.

## Run it

```sh
# on the practice set, from the kit directory
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

Node 22 or later, no dependencies, no install step, no network. Output is
deterministic: two runs on the same input produce byte-identical output.

## Verify it

The kit ships a practice set of 720 cases (680 spec examples plus 40
generated READMEs) with reference HTML. Render it with `main.ts` as above
and diff `/tmp/out/html.json` against
`practice/reference/expected.json`; every case must match byte for byte.
The same driver and the same `parse.js` are what the competition harness
runs, so a local pass is a faithful preview of the graded run.

## Speed

The parser is a single pass over lines for blocks and a single scan for
inline content, with manual index-based scanning instead of regular
expressions on the hot paths, so it renders the 720-case practice set
faster than the marked baseline while matching it exactly.

## License

MIT — see `LICENSE`.
