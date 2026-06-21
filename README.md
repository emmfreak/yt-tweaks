# YouTube Tweaks userscript

A single-file, vanilla-JS userscript (Tampermonkey / Violentmonkey) with two
features:

1. **Per-surface card sizing** — independently scale the homepage grid and the
   watch-page recommended sidebar, with presets **Very small / Small / Medium /
   Native / Very large**. Settings persist separately via `GM_setValue`.
2. **One-click "Add to Queue"** — a `＋ Queue` button appears on each video
   thumbnail on hover (homepage, sidebar, and search results) and runs
   YouTube's native add-to-queue action with a single click.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`youtube-tweaks.user.js`](youtube-tweaks.user.js) (raw) and the
   extension will prompt to install, or paste it into a new script.
3. Reload YouTube.

## Usage

- **Sizing:** click the faint gear button at the bottom-right of any YouTube
  page and pick a preset for *Homepage grid* and *Watch sidebar* independently.
- **Queue:** hover any video thumbnail and click `＋ Queue`.

## How it works (and what might need maintenance)

- **Sizing** is an injected `<style>` tag, persistent so it survives SPA
  navigation. The two surfaces use different (correct) mechanisms:
  - *Homepage grid* overrides the responsive density CSS variables on
    `ytd-rich-grid-renderer` (`--ytd-rich-grid-items-per-row` /
    `--ytd-rich-grid-item-min-width` / `--ytd-rich-grid-item-max-width`) to set
    the column count directly. Presets map to ~7/6/5/native/3 columns.
  - *Watch sidebar* uses CSS `zoom` on the recommendation cards — it's a
    vertical list, so shrinking each card's layout box genuinely fits more rows
    and all text scales with it. Requires Chromium or Firefox 126+.
- **Trusted Types**: YouTube enforces `require-trusted-types-for 'script'`, so
  the script never uses `innerHTML`/`outerHTML`/`insertAdjacentHTML`. All
  elements (including SVG icons) are built via `createElement`/`createElementNS`
  + `textContent`/`setAttribute` through the `el()`/`svgIcon()` helpers.
- **Queue** drives YouTube's own 3-dot menu headlessly (the popup is suppressed
  via CSS so it never flashes) and clicks the real "Add to queue" item — so the
  behaviour is always native. An opt-in direct-command path exists
  (`CONFIG.preferDirectQueueCommand`) but is disabled by default because
  YouTube's internal dispatch hook varies between builds.

### Selectors most likely to drift

Stable selectors (tag/id like `ytd-rich-item-renderer`, `#secondary`,
`ytd-menu-renderer`, `a#thumbnail`) should be durable. The fragile ones are the
newer "view-model" components (`yt-lockup-view-model`,
`yt-lockup-view-model-wiz__*`) — each is tagged with a `FRAGILE:` comment in the
source so they're easy to find and update if YouTube changes them.

> ⚠️ These selectors were written against YouTube's known DOM structure but were
> **not verified against a live page in the build environment** (no browser
> there). If something doesn't bind, open DevTools, confirm the element name,
> and update the matching `FRAGILE:`-tagged selector.
