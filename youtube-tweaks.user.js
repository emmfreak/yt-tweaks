// ==UserScript==
// @name         YouTube Tweaks: Per-Surface Card Sizing + One-Click Add to Queue
// @namespace    https://github.com/emmfreak/yt-tweaks
// @version      1.0.0
// @description  Independently scale homepage grid cards and the watch-page sidebar, plus a one-click "Add to Queue" button on every video thumbnail.
// @author       emmfreak
// @match        https://www.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * ============================================================================
 *  OVERVIEW
 * ============================================================================
 *  Feature 1 — Context-aware card sizing
 *    - Two INDEPENDENT settings, persisted separately via GM_setValue:
 *        * "home"    -> homepage / channel home grid  (ytd-rich-grid-renderer)
 *        * "sidebar" -> watch-page recommendations    (#secondary / #related)
 *    - Presets: very-small | small | medium | native | very-large
 *    - Implemented purely through an injected <style> tag using CSS `zoom`
 *      (see WHY ZOOM note below). Because it is a persistent stylesheet that
 *      matches elements as they appear, it survives YouTube's SPA navigation
 *      and lazy-loaded content automatically — no per-navigation re-apply
 *      needed for the sizing itself.
 *
 *  Feature 2 — One-click "Add to Queue" on hover
 *    - Adds a small "＋ Queue" button overlaid on each video thumbnail,
 *      revealed on hover, on homepage cards, sidebar cards and search results.
 *    - Default implementation drives YouTube's OWN "Add to queue" menu item
 *      headlessly (the menu popup is suppressed via CSS so it never flashes),
 *      which guarantees the real native behaviour. An opt-in direct-command
 *      path is included but disabled by default (see CONFIG + the QUEUE notes).
 *
 *  WHY `zoom` (not transform: scale)?
 *    `transform: scale()` shrinks an element visually but leaves its ORIGINAL
 *    layout box, so a scaled-down grid card leaves a big empty gap and nothing
 *    extra fits. `zoom` scales the layout box too, so the flex grid reflows and
 *    genuinely fits more cards per row / more rows on screen, and ALL nested
 *    text/metadata scales uniformly so cards never look broken. `zoom` is
 *    supported in Chromium (Tampermonkey/Violentmonkey's main targets) and in
 *    Firefox 126+ (May 2024). If you must support older Firefox, swap the
 *    `zoom:` lines in buildSizingCss() for a transform-based block.
 *
 *  SELECTOR FRAGILITY
 *    Tag/id selectors (ytd-rich-item-renderer, #secondary, ytd-menu-renderer,
 *    a#thumbnail, etc.) are stable across YouTube versions. Anything matching an
 *    obfuscated/wiz class name (yt-lockup-view-model-wiz__*) is the newer
 *    "view-model" component family and is the most likely thing to drift — every
 *    such selector is tagged with a `FRAGILE:` comment so you can find and fix
 *    them quickly.
 * ============================================================================
 */

(function () {
  'use strict';

  // ----- GM storage shim (falls back to localStorage if GM_* unavailable) ---
  const store = {
    get(key, def) {
      try { return GM_getValue(key, def); }
      catch (_) {
        const v = localStorage.getItem('ytq_' + key);
        return v === null ? def : v;
      }
    },
    set(key, val) {
      try { GM_setValue(key, val); }
      catch (_) { localStorage.setItem('ytq_' + key, val); }
    }
  };

  // ----- Config --------------------------------------------------------------
  const CONFIG = {
    // Feature 2: when true, try to read YouTube's internal "Add to queue"
    // command from the renderer's polymer data and dispatch it directly (zero
    // menu interaction). Left OFF by default because the internal dispatch hook
    // changes between YouTube builds and a silent no-op can't be detected to
    // fall back. The headless menu simulation below is reliable, so it's the
    // default. Flip this to true only after verifying it works in your build.
    preferDirectQueueCommand: false,
  };

  // Zoom factor per preset. `native` intentionally emits no rule.
  const PRESETS = {
    'very-small': 0.65,
    'small':      0.78,
    'medium':     0.88,
    'native':     1,
    'very-large': 1.2,
  };
  const PRESET_ORDER = ['very-small', 'small', 'medium', 'native', 'very-large'];
  const PRESET_LABELS = {
    'very-small': 'Very small',
    'small':      'Small',
    'medium':     'Medium',
    'native':     'Native',
    'very-large': 'Very large',
  };

  const SURFACES = {
    home:    { key: 'size_home',    default: 'native', label: 'Homepage grid' },
    sidebar: { key: 'size_sidebar', default: 'native', label: 'Watch sidebar' },
  };

  const SUPPRESS_ATTR = 'data-ytq-suppress-menu'; // hides the menu popup flash
  const STYLE_ID = 'ytq-sizing-style';

  // Homepage grid presets -> {cols, minWidth}. The homepage is a RESPONSIVE
  // grid whose density is driven by CSS variables on ytd-rich-grid-renderer
  // (NOT by item width), so we override those vars instead of zooming items.
  // `native` emits no rule so YouTube uses its own responsive default.
  // VERIFY (live DOM): variable names below and that min-width lets columns pack.
  const GRID_PRESETS = {
    'very-small': { cols: 7, minWidth: 120 },
    'small':      { cols: 6, minWidth: 150 },
    'medium':     { cols: 5, minWidth: 180 },
    'native':     null,
    'very-large': { cols: 3, minWidth: 320 },
  };

  // --------------------------------------------------------------------------
  //  DOM helpers — built WITHOUT any string-to-HTML sink (innerHTML/outerHTML/
  //  insertAdjacentHTML). YouTube enforces Trusted Types
  //  (require-trusted-types-for 'script'), which makes those throw and would
  //  abort the whole script. Everything is created with createElement /
  //  createElementNS / textContent / setAttribute instead.
  // --------------------------------------------------------------------------
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'onclick') node.addEventListener('click', v);
        else node.setAttribute(k, v);
      }
    }
    if (children != null) {
      for (const c of [].concat(children)) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function svgIcon(viewBox, paths, attrs) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    if (attrs) for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    for (const d of [].concat(paths)) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  // ==========================================================================
  //  FEATURE 1 — Per-surface card sizing via injected CSS
  // ==========================================================================

  function getSize(surface) {
    return store.get(SURFACES[surface].key, SURFACES[surface].default);
  }
  function setSize(surface, preset) {
    store.set(SURFACES[surface].key, preset);
    applySizing();
  }

  function buildSizingCss() {
    const grid = GRID_PRESETS[getSize('home')];
    const side = PRESETS[getSize('sidebar')] ?? 1;
    let css = '';

    // --- Homepage / channel-home grid ---------------------------------------
    // Override the grid-density CSS variables YouTube sets inline on
    // ytd-rich-grid-renderer. items-per-row controls the column count; the
    // max/min-width bounds are widened/lowered so columns actually pack at the
    // requested count. Text/metadata reflows with the narrower columns.
    // VERIFY (live DOM): these three variable names are current.
    if (grid) {
      css += `
        ytd-rich-grid-renderer {
          --ytd-rich-grid-items-per-row: ${grid.cols} !important;
          --ytd-rich-grid-item-max-width: 9999px !important;
          --ytd-rich-grid-item-min-width: ${grid.minWidth}px !important;
        }
      `;
    }

    // --- Watch-page recommended sidebar -------------------------------------
    // Recommendations live in the right column (#secondary -> #related ->
    // ytd-watch-next-secondary-results-renderer). Classic cards are
    // ytd-compact-video-renderer; newer builds use yt-lockup-view-model.
    // Scoping to #secondary keeps us from touching compact renderers elsewhere
    // (e.g. inside playlists/end-screens).
    if (side !== 1) {
      css += `
        #secondary ytd-compact-video-renderer,
        #related   ytd-compact-video-renderer,
        ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer,
        /* FRAGILE: new "view-model" recommendation card */
        #secondary yt-lockup-view-model,
        #related   yt-lockup-view-model {
          zoom: ${side};
        }
      `;
    }

    // --- Headless queue: suppress the menu popup while we drive it -----------
    // We programmatically open YouTube's 3-dot menu to click "Add to queue".
    // While SUPPRESS_ATTR is set on <html>, the shared popup is invisible and
    // non-interactive to the mouse, but still clickable from JS, so the user
    // never sees it flash. opacity (not display:none) keeps it laid out so
    // YouTube still populates and processes the click.
    css += `
      html[${SUPPRESS_ATTR}] ytd-popup-container tp-yt-iron-dropdown {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;

    return css;
  }

  function applySizing() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = buildSizingCss();
  }

  // ==========================================================================
  //  FEATURE 2 — One-click "Add to Queue" button on hover
  // ==========================================================================

  // Card containers across the three surfaces:
  //   ytd-rich-item-renderer   -> homepage / channel home grid
  //   ytd-compact-video-renderer -> watch sidebar (classic)
  //   ytd-video-renderer       -> search results & list views (classic)
  //   yt-lockup-view-model     -> FRAGILE: newer search/related card
  const CARD_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-compact-video-renderer',
    'ytd-video-renderer',
    'yt-lockup-view-model',
  ].join(',');

  // Localised text for the "Add to queue" menu item. Used only as a fallback
  // if matching by icon type fails. Add your locale's string here if needed.
  const QUEUE_LABELS = [
    'add to queue', 'in warteschlange einreihen', 'añadir a la cola',
    'ajouter à la file d’attente', 'aggiungi alla coda', 'adicionar à fila',
    'в очередь', 'キューに追加', '添加到队列', '대기열에 추가',
  ];

  // The icon type YouTube tags the "Add to queue" menu item with. This is the
  // most locale-proof way to identify the item. (Stable enum string.)
  const QUEUE_ICON_TYPE = 'ADD_TO_QUEUE_TAIL';

  let queueBusy = false;

  function buttonStyle() {
    const css = `
      .ytq-thumb-host { position: relative !important; }
      .ytq-btn {
        position: absolute;
        top: 6px;
        right: 6px;
        z-index: 60;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        font: 500 1.2rem/1 "Roboto", Arial, sans-serif;
        color: #fff;
        background: rgba(0, 0, 0, 0.85);
        border: none;
        border-radius: 16px;
        cursor: pointer;
        opacity: 0;
        transition: opacity .12s ease, background .12s ease;
        pointer-events: none;
      }
      .ytq-btn:hover { background: rgba(0, 0, 0, 0.95); }
      .ytq-btn.ytq-done { background: #2ba640; }
      ${CARD_SELECTOR.split(',').map(s => `${s.trim()}:hover .ytq-btn`).join(',\n      ')} {
        opacity: 1;
        pointer-events: auto;
      }
      .ytq-btn svg { width: 14px; height: 14px; fill: currentColor; }
    `;
    const el = document.createElement('style');
    el.id = 'ytq-button-style';
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  // Find the element to overlay the button onto (the thumbnail area of a card).
  function getThumbHost(card) {
    return (
      card.querySelector('ytd-thumbnail a#thumbnail') ||
      card.querySelector('a#thumbnail') ||
      card.querySelector('ytd-thumbnail') ||
      // FRAGILE: view-model thumbnail wrapper
      card.querySelector('.yt-lockup-view-model-wiz__content-image') ||
      card.querySelector('a.yt-lockup-view-model-wiz__content-image')
    );
  }

  function makeButton() {
    return el('button', { class: 'ytq-btn', type: 'button', title: 'Add to queue' }, [
      svgIcon('0 0 24 24',
        'M2 6h12v2H2zM2 12h12v2H2zM2 18h8v2H2zM14 14v4h-4v2h4v4h2v-4h4v-2h-4v-4z'),
      el('span', { text: 'Queue' }),
    ]);
  }

  function addButtonToCard(card) {
    // Re-add if missing (YouTube recycles polymer nodes and may strip children).
    if (card.querySelector(':scope .ytq-btn')) return;
    const host = getThumbHost(card);
    if (!host) return;
    host.classList.add('ytq-thumb-host');

    const btn = makeButton();
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onQueueClick(card, btn);
    }, true);
    host.appendChild(btn);
  }

  function processCards(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(CARD_SELECTOR).forEach(addButtonToCard);
  }

  async function onQueueClick(card, btn) {
    let ok = false;
    if (CONFIG.preferDirectQueueCommand) {
      try { ok = dispatchDirectQueueCommand(card); } catch (_) { ok = false; }
    }
    if (!ok) ok = await addToQueueViaMenu(card);

    if (ok) {
      btn.classList.add('ytq-done');
      btn.querySelector('span').textContent = 'Queued';
      setTimeout(() => {
        btn.classList.remove('ytq-done');
        btn.querySelector('span').textContent = 'Queue';
      }, 1500);
    }
  }

  // --- Direct command path (opt-in, see CONFIG) ------------------------------
  // Reads YouTube's own "Add to queue" service endpoint out of the card's
  // polymer data and asks ytd-app to resolve it. The command shape and the
  // resolveCommand hook both vary by build, hence this is opt-in and guarded.
  function getPolymerData(el) {
    return el && (el.data || el.__data?.data || el.polymerController?.data || el.inst?.data);
  }
  function dispatchDirectQueueCommand(card) {
    const data = getPolymerData(card);
    const items = data?.menu?.menuRenderer?.items;
    if (!Array.isArray(items)) return false;
    let endpoint = null;
    for (const it of items) {
      const r = it.menuServiceItemRenderer;
      if (r && r.icon?.iconType === QUEUE_ICON_TYPE) {
        endpoint = r.serviceEndpoint;
        break;
      }
    }
    if (!endpoint) return false;
    const app = document.querySelector('ytd-app');
    // resolveCommand is YouTube's internal endpoint dispatcher (may not exist).
    if (app && typeof app.resolveCommand === 'function') {
      app.resolveCommand(endpoint, {});
      return true;
    }
    return false;
  }

  // --- Headless menu-simulation path (reliable default) ----------------------
  async function addToQueueViaMenu(card) {
    if (queueBusy) return false;
    queueBusy = true;
    document.documentElement.setAttribute(SUPPRESS_ATTR, '');
    try {
      const menuBtn = findMenuButton(card);
      if (!menuBtn) throw new Error('3-dot menu button not found');
      menuBtn.click();

      // The shared popup populates asynchronously; wait for the queue item.
      const item = await waitFor(findQueueMenuItem, 2500);
      item.click();
      return true;
    } catch (err) {
      console.warn('[yt-tweaks] Add to queue failed:', err.message);
      return false;
    } finally {
      // Make sure the (hidden) menu is dismissed, then reveal popups again.
      closeAnyOpenMenu();
      // Defer removing suppression one frame so the closing menu doesn't flash.
      requestAnimationFrame(() => {
        document.documentElement.removeAttribute(SUPPRESS_ATTR);
      });
      queueBusy = false;
    }
  }

  function findMenuButton(card) {
    return (
      // Classic renderers: ytd-menu-renderer with a yt-icon-button/#button.
      card.querySelector('ytd-menu-renderer yt-icon-button#button') ||
      card.querySelector('ytd-menu-renderer #button button') ||
      card.querySelector('ytd-menu-renderer button') ||
      // FRAGILE: view-model card "More actions" button.
      card.querySelector('button[aria-label*="ction" i]') ||
      card.querySelector('yt-icon-button')
    );
  }

  function findQueueMenuItem() {
    // Menu items render inside the shared ytd-popup-container.
    const items = document.querySelectorAll(
      'ytd-popup-container ytd-menu-service-item-renderer,' +
      'ytd-popup-container ytd-menu-navigation-item-renderer,' +
      // FRAGILE: newer list-item view-model menu rows.
      'ytd-popup-container yt-list-item-view-model'
    );
    if (!items.length) return null;
    // 1) Prefer matching by icon type (locale-proof).
    for (const it of items) {
      const d = getPolymerData(it);
      if (d?.icon?.iconType === QUEUE_ICON_TYPE) return it;
      if (it.querySelector(`yt-icon[icon*="queue" i]`)) return it;
    }
    // 2) Fallback: match by visible text against known locale strings.
    for (const it of items) {
      const t = (it.textContent || '').trim().toLowerCase();
      if (t && QUEUE_LABELS.some(l => t === l || t.includes(l))) return it;
    }
    return null;
  }

  function closeAnyOpenMenu() {
    // Sending Escape to the active popup reliably dismisses YouTube's dropdown.
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
                   bubbles: true, cancelable: true };
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
  }

  // Resolve when selectorFn() returns truthy, using a MutationObserver so we
  // don't poll. Rejects after `timeout` ms.
  function waitFor(fn, timeout) {
    return new Promise((resolve, reject) => {
      const first = fn();
      if (first) return resolve(first);
      const obs = new MutationObserver(() => {
        const v = fn();
        if (v) { obs.disconnect(); clearTimeout(timer); resolve(v); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        reject(new Error('timed out waiting for menu'));
      }, timeout || 2000);
    });
  }

  // ==========================================================================
  //  SETTINGS UI — unobtrusive gear button + small panel
  // ==========================================================================

  function buildSettingsUi() {
    if (document.getElementById('ytq-ui')) return;

    const style = document.createElement('style');
    style.textContent = `
      #ytq-gear {
        position: fixed; right: 14px; bottom: 14px; z-index: 9000;
        width: 34px; height: 34px; border-radius: 50%;
        background: rgba(33,33,33,.7); color: #fff; border: none;
        cursor: pointer; opacity: .45; transition: opacity .15s, transform .15s;
        display: flex; align-items: center; justify-content: center; padding: 0;
      }
      #ytq-gear:hover { opacity: 1; transform: rotate(30deg); }
      #ytq-gear svg { width: 20px; height: 20px; fill: currentColor; }
      #ytq-panel {
        position: fixed; right: 14px; bottom: 56px; z-index: 9000;
        width: 230px; padding: 14px; border-radius: 12px;
        background: #212121; color: #fff; box-shadow: 0 4px 24px rgba(0,0,0,.5);
        font: 400 13px/1.4 "Roboto", Arial, sans-serif; display: none;
      }
      #ytq-panel.open { display: block; }
      #ytq-panel h3 { margin: 0 0 4px; font-size: 13px; font-weight: 500; opacity: .8; }
      #ytq-panel .ytq-group { margin-bottom: 12px; }
      #ytq-panel .ytq-opts { display: flex; flex-wrap: wrap; gap: 4px; }
      #ytq-panel .ytq-opt {
        flex: 1 1 auto; padding: 4px 6px; border-radius: 6px;
        background: #383838; color: #fff; border: 1px solid transparent;
        cursor: pointer; font-size: 12px; text-align: center; white-space: nowrap;
      }
      #ytq-panel .ytq-opt:hover { background: #4a4a4a; }
      #ytq-panel .ytq-opt.active { background: #3ea6ff; color: #0a0a0a; font-weight: 500; }
      #ytq-panel .ytq-foot { font-size: 11px; opacity: .5; margin-top: 4px; }
    `;
    document.documentElement.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'ytq-ui';

    const gear = el('button', { id: 'ytq-gear', title: 'YouTube Tweaks — card sizing' }, [
      svgIcon('0 0 24 24',
        'M19.14 12.94a7.49 7.49 0 0 0 .05-.94 7.49 7.49 0 0 0-.05-.94l2.03-1.58a.5' +
        '.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96a7 7 0 0 0-1.62-.94' +
        'l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7 7 0 0 0-1.62' +
        '.94l-2.39-.96a.5.5 0 0 0-.59.22L2.74 8.87a.5.5 0 0 0 .12.61l2.03 1.58a7.49' +
        ' 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32a.5.5 0 0 0 .59.22' +
        'l2.39-.96a7 7 0 0 0 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42' +
        'l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .59-.22l1.92-3.32a.5.5 0 0 0' +
        '-.12-.61zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z'),
    ]);

    const panel = document.createElement('div');
    panel.id = 'ytq-panel';

    for (const surface of Object.keys(SURFACES)) {
      const group = document.createElement('div');
      group.className = 'ytq-group';
      const h = document.createElement('h3');
      h.textContent = SURFACES[surface].label;
      group.appendChild(h);

      const opts = document.createElement('div');
      opts.className = 'ytq-opts';
      for (const preset of PRESET_ORDER) {
        const o = document.createElement('button');
        o.className = 'ytq-opt';
        o.dataset.surface = surface;
        o.dataset.preset = preset;
        o.textContent = PRESET_LABELS[preset];
        if (getSize(surface) === preset) o.classList.add('active');
        o.addEventListener('click', () => {
          setSize(surface, preset);
          panel.querySelectorAll(`.ytq-opt[data-surface="${surface}"]`)
               .forEach(b => b.classList.toggle('active', b.dataset.preset === preset));
        });
        opts.appendChild(o);
      }
      group.appendChild(opts);
      panel.appendChild(group);
    }

    const foot = document.createElement('div');
    foot.className = 'ytq-foot';
    foot.textContent = 'Hover a thumbnail for ＋ Queue';
    panel.appendChild(foot);

    gear.addEventListener('click', () => panel.classList.toggle('open'));
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) panel.classList.remove('open');
    });

    wrap.appendChild(panel);
    wrap.appendChild(gear);
    document.body.appendChild(wrap);
  }

  // ==========================================================================
  //  BOOTSTRAP
  // ==========================================================================

  // Run a step in isolation so one failure can't abort the rest of bootstrap.
  function safe(label, fn) {
    try { return fn(); }
    catch (err) { console.error(`[yt-tweaks] ${label} failed:`, err); }
  }

  function onReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  // Inject sizing CSS as early as possible to avoid a flash of full-size cards.
  safe('applySizing', applySizing);

  onReady(() => {
    safe('buttonStyle', buttonStyle);
    safe('buildSettingsUi', buildSettingsUi);
    safe('processCards', () => processCards(document));

    // Re-scan for new/lazy-loaded cards. Debounced so bursts of mutations
    // (infinite scroll, SPA nav) coalesce into a single pass.
    let pending = null;
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = null;
        safe('processCards', () => processCards(document));
      });
    });
    safe('observe', () => observer.observe(document.body, { childList: true, subtree: true }));

    // YouTube fires this after every SPA navigation. Re-scan and make sure our
    // UI/sizing survived (the persistent <style> tags normally do).
    window.addEventListener('yt-navigate-finish', () => {
      safe('applySizing', applySizing);
      safe('buildSettingsUi', buildSettingsUi);
      safe('processCards', () => processCards(document));
    });
  });

})();
