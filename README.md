# markdown-flash

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Klowor2002/markdown-flash/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Klowor2002/markdown-flash/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

markdown-flash is a dependency-free JavaScript Markdown renderer written from
scratch. It reproduces the HTML output of marked 18.1.3 with default options
(GFM enabled, line breaks off, pedantic off) byte for byte — CommonMark blocks
and inlines, GFM tables, strikethrough, task lists, extended autolinks, and
marked's own edge-case behaviours included — while rendering faster than the
reference implementation. The whole engine lives in a single file,
`parse.js`, which exports one function, `parse(markdown)`, returning the HTML
string for a document. `main.ts` is a small batch driver around it.

## Run it

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

The driver reads `cases.json` (a JSON array of `{id, markdown}` objects) from
the input directory, renders every case on its own through `parse()`, and
writes `html.json` — a JSON array of the HTML strings in input order — into
the output directory. Without the environment variables it defaults to
`/input` and `/output`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=5svq4vk4&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
