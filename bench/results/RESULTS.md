# webclaw benchmark results

- date: 2026-10-21T14:34:05.252Z · webclaw 0.10.0 · node v26.8.1 · mode standalone · Google Chrome for Testing 153.0.8010.12, headless, macOS arm64 (arm64)
- 10 deterministic local tasks × 3 reps; time = median of successful reps, measured after the page loaded
- rt = round-trips (each one is an agent turn in a tool-calling loop) · KB = bytes returned to the agent (÷4 ≈ tokens)
- no LLM involved: this isolates the browser-tool layer; it is not comparable 1:1 with LLM-in-the-loop benchmarks

| task | step | run | relay |
|---|---|---|---|
| login — Log in through a form | 3/3 · 60 ms · 5 rt · 0.3 KB | 3/3 · 48 ms · 1 rt · 0.0 KB | 3/3 · 221 ms |
| search — Search and extract result rows | 3/3 · 75 ms · 4 rt · 0.3 KB | 3/3 · 42 ms · 1 rt · 0.1 KB | 3/3 · 87 ms |
| wizard — 3-step wizard (radio, select, checkbox) | 3/3 · 151 ms · 9 rt · 0.7 KB | 3/3 · 171 ms · 1 rt · 0.0 KB | 3/3 · 194 ms |
| controlled-input — Framework-controlled input enables a button | 3/3 · 39 ms · 3 rt · 0.2 KB | 3/3 · 44 ms · 1 rt · 0.0 KB | 3/3 · 118 ms |
| cross-origin-iframe — Click inside a cross-origin iframe | 3/3 · 34 ms · 3 rt · 0.3 KB | 3/3 · 37 ms · 1 rt · 0.0 KB | 3/3 · 52 ms |
| shadow-dom — Button inside an open shadow root | 3/3 · 32 ms · 2 rt · 0.2 KB | 3/3 · 50 ms · 1 rt · 0.0 KB | 3/3 · 37 ms |
| pagination — Collect 30 items across 3 pages | 3/3 · 102 ms · 7 rt · 0.6 KB | 3/3 · 75 ms · 1 rt · 0.0 KB | 3/3 · 140 ms |
| upload — Attach a local file | 3/3 · 29 ms · 2 rt · 0.2 KB | 3/3 · 33 ms · 1 rt · 0.1 KB | 3/3 · 40 ms |
| delayed — Wait for late content and read it | 3/3 · 1556 ms · 2 rt · 0.0 KB | 3/3 · 1567 ms · 1 rt · 0.0 KB | 3/3 · 1529 ms |
| modal — Confirm inside a modal dialog | 3/3 · 74 ms · 4 rt · 0.4 KB | 3/3 · 46 ms · 1 rt · 0.0 KB | 3/3 · 68 ms |
| **total** | **30/30 (100%) · 2152 ms · 41 rt · 3.2 KB** | **30/30 (100%) · 2113 ms · 10 rt · 0.4 KB** | **30/30 (100%) · 2486 ms** |
