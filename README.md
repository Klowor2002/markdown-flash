# markdown-flash

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Klowor2002/markdown-flash/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Klowor2002/markdown-flash/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

FlashMark is a from-scratch Markdown-to-HTML renderer written for speed. Its single entry point, `parse(markdown)` in `parse.js`, returns exactly the HTML that marked 18.1.3's `marked.parse` returns with default options (GFM on, line breaks off, pedantic off) — byte for byte, including marked's own departures from the CommonMark and GFM specs. The renderer is dependency-free: a hand-written block engine (container stack with column-accurate tab handling for lists, block quotes, fenced and indented code, tables and HTML blocks) feeds a single-pass inline scanner (delimiter-stack emphasis, bracket-stack links and images, code spans, entities, and GFM extended autolinks). There is no caching between calls and no lookup of expected output — every byte of HTML is computed from the Markdown it is given.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` reads every case from `cases.json` in the input directory (an array of `{"id", "markdown"}` objects), renders each one with `parse`, and writes `html.json` — a JSON array of the HTML strings in case order — to the output directory. With no environment overrides it reads `/input` and writes `/output`, which is how the competition harness runs it.

---

<sub>Entered on [make.fun](https://make.fun/?ref=5svq4vk4&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
