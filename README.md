# markdown-flash

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Klowor2002/markdown-flash/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Klowor2002/markdown-flash/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free JavaScript Markdown renderer that reproduces the output of marked 18.1.3 (default options: GFM on, breaks off, pedantic off) byte-for-byte — CommonMark, GFM tables, autolinks, task lists and marked's own quirks included — while rendering considerably faster. `parse.js` exports a single `parse(markdown)` function; `main.ts` is the batch driver that renders a directory of cases.

## Run it

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=5svq4vk4&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
