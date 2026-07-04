# Jarvis UI Redesign — project notes

## Design direction (user-approved)
Movie-accurate JARVIS HUD: cyan/ice-blue (#38c6ff / #7fdcff on #02060d), glass panels with
corner brackets, Michroma (eyebrows/wordmark) + Rajdhani (UI/numbers) + JetBrains Mono (data),
boot sequence on load, full-screen voice takeover. Trase design system intentionally NOT used
(user chose pure sci-fi aesthetic). Source codebase: local folder "Jarvis" (Next.js dashboard,
`apps/dashboard/app/globals.css` is the styling API to map back to).

## Rendering pitfalls discovered in this project (do not reintroduce)
- **Never use `backdrop-filter`** — it makes the DOM-capture screenshot renderer paint the
  element subtree as blank/black. Use more opaque rgba backgrounds instead.
- **Don't use `position: fixed` for the app shell** in DCs; use `position: relative; height: 100vh`.
- **No per-second `setState` clocks.** Live clock/uptime are updated by direct DOM writes to
  `#hud-clock`, `#hud-date`, `#hud-uptime`, `#hud-now` in `_tick()`; renderVals returns
  `_timeStrings()` so React renders stay correct. Keeps captures and animations stable.
- **No entrance animations that start at `opacity: 0`** (fadeUp/orbIn) — frozen first frames in
  throttled/hidden iframes black out content. Infinite ambient loops are fine if frame 0 looks OK.
