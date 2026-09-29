# Grove UI: Zen look, implementation spec

Source: Zen Browser desktop repo at `/home/therion/Projects/zen-desktop` (Firefox 157 base, per `surfer.json:8`).
Upstream Firefox values come from `mozilla-firefox/firefox@FIREFOX_157_0_RELEASE`
(`browser/themes/shared/tabbrowser/tabs.css` is cited as **FF tabs.css**, and
`toolkit/themes/shared/design-system/dist/tokens-table.mjs` as **FF tokens**). All other
paths are relative to `zen-desktop/`. `src/zen/...` is shortened to `zen/...`.

Legend:
- **[src]** means the value is read directly from source. The file:line is given.
- **[derived]** means it is computed from several source values. The math is shown.
- **[inferred]** means it is not directly in source, or it depends on runtime/OS. Verify it visually.

Chromium notes. `light-dark()` (Chrome 123+), `color-mix()` (111+), relative color
`oklch(from …)` (119+) and `corner-shape: superellipse()` (139+) all work in a WebUI page.
That means most of Zen's formulas can be pasted as-is. Put `color-scheme: light dark` (or a forced
scheme) on `:root` so that `light-dark()` resolves.

---

## 0. Licensing (read first)

1. **Zen CSS/JS is MPL-2.0 (file-level copyleft).** Any file that contains code copied or
   adapted from Zen or Firefox has to stay MPL-2.0 and keep this header:
   ```css
   /* This Source Code Form is subject to the terms of the Mozilla Public
    * License, v. 2.0. If a copy of the MPL was not distributed with this
    * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
   ```
   Recommendation: put every Zen-derived rule in a separate file (e.g. `zen-theme.css`)
   that carries this header. Your other files keep your own license. Values alone (numbers,
   colors) are not copyrightable, so re-typing them into your own rules is fine. Verbatim or
   near-verbatim rule blocks and the folder SVG should go in the MPL file.
2. **Most of Zen's toolbar icons are NOT MPL.** `src/browser/themes/shared/zen-icons/jar.inc.mn`
   maps `back/forward/reload/plus/close/folder/menu/...` on **all platforms** (Win l.5–156,
   mac l.157–308, Linux l.309–460) to `zen-icons/nucleo/*.svg`. The notice at
   `zen-icons/nucleo/nucleo-copyright-notice.html` says: *"The Nucleo icons are copyrighted.
   Redistribution is not permitted … only if you possess a Nucleo license."* The SVG files
   carry an MPL header anyway, but **do not copy them**. See §10 for alternatives.
3. `zen-icons/common/selectable/*.svg` (workspace/emoji picker icons) are Ionicons, **MIT**
   (`common/selectable/CREDITS.md`). They are safe to reuse with attribution.

---

## 1. Global tokens

### 1.1 Typography

| Token | Value | Source |
|---|---|---|
| UI font, Linux | not set by Zen, so it inherits the GTK system UI font. Use `system-ui`. | zen-theme.css:289-303 (only mac/win set) [src] |
| UI font, macOS | `SF Pro, ui-sans-serif, system-ui, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol, Noto Color Emoji` | zen-theme.css:290-298 [src] |
| UI font, Windows | `'Segoe UI', Tahoma, Geneva, Verdana, sans-serif` | zen-theme.css:302 [src] |
| Tab list font-size | Windows `14px`; macOS `1.25rem`; Linux inherits the system size | vertical-tabs.css:292-298 [src] |
| Recommended tab font-size for Grove | `13px` on Linux, `14px` on Windows | [inferred] (Linux GTK default ≈ 11pt ≈ 14.67px; Zen in practice looks ~13px) |
| Tab label line-height | `1.7` | FF tokens:2048 `--tab-label-line-height` [src] |
| Workspace indicator | `font-size: small; font-weight: 600` (name) | zen-workspaces.css:191, 266 [src] |
| URL bar text | `font-weight: 500`; color = field text at 70% | zen-omnibox.css:131, 135 [src] |
| Folder label | `font-weight: 600` | zen-folders.css:86, 173 [src] |
| Workspace-strip emoji | `12px` (mac `15px`); svg icon `14px` (mac `16px`) | zen-workspaces.css:55-67 [src] |
| "Clear" (separator button) | `10px`, weight `500` | vertical-tabs.css:189-190 [src] |
| Tab sublabel ("Back to pinned url") | `x-small`, opacity `.5` | vertical-tabs.css:505, 512 [src] |

### 1.2 Radii and the squircle

| Token | Value | Source |
|---|---|---|
| `--zen-border-radius` (window/native radius) | Linux: `env(-moz-gtk-csd-titlebar-radius, 8px)`, so **8px** by default; Windows **9px**; macOS **10px** (Tahoe **11px**) | zenThemeModifier.js:108-137 [src]; pref `zen.theme.border-radius = -1` prefs/zen/theme.yaml:46 |
| `--border-radius-medium` inside sidebar | **14px**. Used by tab backgrounds, essentials, urlbar, folder hover, and indicator hover. | vertical-tabs.css:235 [src] |
| `--tab-border-radius` | **8px**. Used by the close button, create-new button, and toolbar buttons. | vertical-tabs.css:236; zen-single-components.css:188 [src] |
| `--toolbarbutton-border-radius` | 6px at root, but **8px** on `.toolbarbutton-1` (every sidebar button) | zen-theme.css:217; zen-single-components.css:189 [src] |
| URL bar radius when open/floating | **15px** | zen-omnibox.css:300 [src] |
| Squircle | `--zen-squircle-value: 1.3` (Windows `2.3`) | zen-theme.css:220-224 [src] |
| Squircle application | `*:not(.no-squircles) { corner-shape: superellipse(var(--zen-squircle-value)); }`. The pref is on by default. | zen-theme.css:358-363; prefs/firefox/browser.yaml:98-99 [src] |
| Squircle exclusions (`corner-shape: round`) | circular/pill things: audio overlay, favicons in URL results, progress bar, status panel, collapsed-tab close button | squircle-exclusions.inc.css:10-36 [src] |

The squircle applies to **everything**. A 14px radius with `superellipse(1.3)` looks tighter
than a plain 14px round corner. For Grove, apply `corner-shape: superellipse(1.3)` globally
and opt out circles with a `.no-squircle` class. If you target a Chromium older than 139,
approximate it with `border-radius: 11px` [inferred visual equivalent].

### 1.3 Spacing

| Token | Value | Source |
|---|---|---|
| `--zen-element-separation` (gap around the web content card) | **8px**. Pref `zen.theme.content-element-separation`, clamped to a max. | prefs/zen/theme.yaml:8-9; zenThemeModifier.js:143-167 [src] |
| `--zen-toolbox-padding` (sidebar inner padding) | **5px** (macOS **6px**) | vertical-tabs.css:86-94 [src] |
| `--tab-margin-block` (vertical gap above/below each tab bg) | **2px** | vertical-tabs.css:305 [src] |
| `--tab-inline-padding` (tab content inline padding) | **8px** | vertical-tabs.css:619 [src] |
| `--toolbarbutton-padding-inner` in tabs | **10px** (used for favicon margins) | vertical-tabs.css:527 [src] |
| Toolbar button inner padding | **6px** (icon 16px, so a 28px button) | zen-single-components.css:190; zen-theme.css:159,172 [src] |
| `--zen-toolbar-button-size` (icon) | **16px** (mac 17px; sidebar foot on mac 20px) | zen-theme.css:172-175; vertical-tabs.css:448-453 [src] |
| `--size-item-small` / `--size-item-medium` | **16px / 24px** | FF tokens.css:479-480 [src] |

### 1.4 Colors

`--zen-primary-color` defaults to the OS `AccentColor` (zen-theme.css:11, pref
`zen.theme.accent-color`). When a workspace has a theme, JS overrides it (see §8.3).
`--zen-branding-bg` is `#e2e2e2` in light and `#101010` in dark (zen-theme.css:16-19).
`--zen-branding-bg-reverse` is the opposite.

These tokens are paste-able for Chromium. They are copied from zen-theme.css, so they go in the MPL file:

```css
:root {
  --zen-primary-color: AccentColor;                     /* zen-theme.css:11 */
  --zen-branding-bg: light-dark(#e2e2e2, #101010);      /* :16-19 */
  --zen-branding-bg-reverse: light-dark(#101010, #e2e2e2);

  /* sidebar text; set by JS, default ≈ 90% black/white (ZenGradientGenerator.mjs:1504-1516) */
  --toolbox-textcolor: light-dark(rgba(0,0,0,.9), rgba(255,255,255,.9));

  /* element fills */
  --zen-toolbar-element-bg: light-dark(                 /* :143-146 */
    color-mix(in oklch, var(--toolbox-textcolor) 8%, transparent),
    color-mix(in oklch, var(--toolbox-textcolor) 15%, transparent));
  --zen-toolbar-element-bg-hover: light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1)); /* :148 */

  /* generic hover/active (tabs, toolbar buttons) */
  --toolbarbutton-background-color-hover:  color-mix(in srgb, var(--zen-branding-bg-reverse) 7%,  transparent); /* :167-171 */
  --toolbarbutton-background-color-active: color-mix(in srgb, var(--zen-branding-bg-reverse) 10%, transparent); /* :184-188 */
  --tab-background-color-hover: var(--toolbarbutton-background-color-hover);                                    /* :266 */

  /* selected tab (set on each workspace element, zen-workspaces.css:337-341) */
  --tab-background-color-selected: light-dark(
    color-mix(in srgb, rgba(255,255,255,.8) 98%, var(--zen-primary-color)),
    color-mix(in srgb, rgba(255,255,255,.18) 95%, var(--zen-primary-color)));
  --tab-box-shadow-selected: 0 0.8px 1.5px 0 light-dark(rgba(0,0,0,.15), rgba(0,0,0,.05));

  /* derived palette (rarely visible in the sidebar; dialogs/settings) */
  --zen-colors-primary: light-dark(color-mix(in srgb, var(--zen-primary-color) 50%, black 50%),
                                   color-mix(in srgb, var(--zen-primary-color) 20%, var(--zen-branding-bg) 80%)); /* :23-26 */
  --zen-colors-secondary: light-dark(color-mix(in srgb, var(--zen-colors-primary) 20%, white 80%),
                                     color-mix(in srgb, var(--zen-primary-color) 30%, var(--zen-branding-bg) 70%)); /* :27-30 */
  --zen-colors-tertiary: light-dark(color-mix(in srgb, var(--zen-primary-color) 2%, white 98%),
                                    color-mix(in srgb, var(--zen-primary-color) 1%, var(--zen-branding-bg) 99%)); /* :31-34 */
  --zen-colors-border: light-dark(color-mix(in srgb, var(--zen-colors-secondary) 50%, transparent),
                                  color-mix(in srgb, var(--zen-colors-secondary) 20%, rgb(79,79,79))); /* :44-47 */
  --zen-sidebar-themed-icon-fill: light-dark(color-mix(in srgb, var(--zen-primary-color) 50%, black),
                                             color-mix(in srgb, var(--zen-colors-primary) 15%, #ebebeb)); /* :277 */
}
```

Resolved values, where they do not depend on the accent:

| Token | Light | Dark | Source |
|---|---|---|---|
| Sidebar/window background (default theme, opaque Linux/Win) | **`#e9e9e9`** | **`#131313`** | ZenGradientGenerator.mjs:1342-1347 [src] |
| CSS fallback before JS runs (`--zen-main-browser-background`) | `rgb(235,235,235)` | `#1b1b1b` | zen-theme.css:209 [src] |
| App wrapper bg under everything (`--zen-themed-toolbar-bg-transparent`) | `#e2e2e2` | `#171717` | zen-theme.css:230; zen-browser-ui.css:140 [src] |
| Text (`--toolbox-textcolor`) | `rgba(0,0,0,.9)` | `rgba(255,255,255,.9)` | ZenGradientGenerator.mjs:1504-1516 [src]; blended 5% toward accent when themed |
| Tab hover bg | `rgba(16,16,16,.07)` | `rgba(226,226,226,.07)` | [derived] from branding-bg-reverse 7% |
| Toolbar button active | `rgba(16,16,16,.10)` | `rgba(226,226,226,.10)` | [derived] |
| `--zen-toolbar-element-bg` | ≈ `rgba(0,0,0,.072)` | ≈ `rgba(255,255,255,.135)` | [derived] (8%/15% of a 0.9-alpha text color) |
| `--zen-toolbar-element-bg-hover` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.10)` | zen-theme.css:148 [src] |
| Selected tab bg | ≈ `rgba(255,255,255,.80)` + 2.5% accent tint | ≈ `rgba(255,255,255,.22)` with ~23% accent tint | [derived] (premultiplied color-mix) |
| Selected tab shadow | `0 .8px 1.5px 0 rgba(0,0,0,.15)` | `0 .8px 1.5px 0 rgba(0,0,0,.05)` | zen-workspaces.css:341 [src] |
| Web page bg (card while loading) | `#fff` | `rgb(32,32,32)` | zen-browser-container.css:19-21 [src] |
| Divider line (pinned/normal separator) | `rgba(0,0,0,.1)` | `rgba(255,255,255,.1)` | vertical-tabs.css:159 [src] |
| Scroll-edge hairline | `rgba(0,0,0,.08)` | `rgba(255,255,255,.08)` | zen-workspaces.css:374 [src] |

### 1.5 Shadows

| Name | Value | Source |
|---|---|---|
| `--zen-big-shadow` (web content card, split panes, glance) | `rgba(0,0,0,.24) 0px 3px 8px` | zen-theme.css:262 [src] |
| Selected tab | see above | zen-workspaces.css:341 |
| Floating URL bar | `0 30px 140px -15px light-dark(rgba(0,0,0,.8), rgba(0,0,0,.6))` + `outline: .5px solid light-dark(rgba(0,0,0,.2), rgb(75,75,75))` | zen-omnibox.css:287-290 [src] |
| Sidebar notification | `0 0 6px light-dark(rgba(0,0,0,.1), rgba(0,0,0,.3))` | zen-theme.css:274 [src] |

### 1.6 Motion

| What | Duration / easing | Source |
|---|---|---|
| Tab press scale | `scale: .985` (`--zen-active-tab-scale`), `transition: scale .1s ease` | zen-theme.css:263; vertical-tabs.css:316-342 [src] |
| Favicon press | `scale: .97` | vertical-tabs.css:346-348 [src] |
| Toolbar button press | `transform: scale(.95)`; `transition: background-color .1s, transform .2s` | zen-single-components.css:194-204 [src] |
| Indent change (folders) | `margin-inline-start .1s ease-in-out` | zen-theme.css:204 [src] |
| Hidden toolbar | `.15s ease-in-out` | zen-theme.css:205-206 [src] |
| Tab open | new item: `opacity 0→1`, `scale(.95)→scale(1)`, 120ms easeOut. Label: `blur(1px)→0`, 100ms. Items below slide `translateY(-h)→0`, 120ms ease-out. | ZenUIManager.mjs:1087-1140 [src] |
| Tab close | `opacity 1→0`, `scale(1)→(.95)`, `margin-bottom 0→-h`, 100ms easeOut | ZenUIManager.mjs:1154-1180 [src] |
| Folder collapse/expand | 180ms ease-in-out (height/opacity/marginTop) | ZenFolders.mjs:1664-1666, 1736-1753 [src] |
| Folder icon morph | `.3s cubic-bezier(0.42, 0, 0, 1)` | zen-folder-icon.inc.css:5-10 [src] |
| Workspace switch | 250ms (pref `zen.workspaces.switch-animation-duration`) | prefs/zen/workspaces.yaml [src] |
| Compact sidebar reveal | `.25s` with a spring `linear(...)` curve (overshoots to 1.0109 at 72%). Hide is `.15s ease`. | compact-mode/sidebar.inc.css:81-84, 171-275 [src] |
| Grain overlay fade | `opacity .2s ease-in-out` | zen-browser-ui.css:100-103 [src] |

---

## 2. Window layout

```
┌──────────────────────────────── window (bg = workspace gradient) ─────────────────────────────┐
│ ┌── sidebar (186px) ──┐   8px top strip (window controls appear here on hover, Linux/Win)     │
│ │ top buttons 36px     │ ┌──────────────────── web content card ─────────────────────────┐    │
│ │ URL bar  ~37px       │ │ radius ≈4px (Linux default), shadow rgba(0,0,0,.24) 0 3px 8px │ 8px │
│ │ essentials grid      │ │                                                              │    │
│ │ workspace indicator  │ │                                                              │    │
│ │ pinned tabs          │ │                                                              │    │
│ │ ── separator ──      │ │                                                              │    │
│ │ + New Tab            │ │                                                              │    │
│ │ tabs…                │ │                                                              │    │
│ │ foot: ⬇  ● ● ●  +    │ └──────────────────────────────────────────────────────────────┘    │
│ └──────────────────────┘                          8px                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Item | Value | Source |
|---|---|---|
| Sidebar side | left (`zen.tabs.vertical.right-side = false`) | prefs/zen/zen.yaml:8-9 [src] |
| Default layout mode | **single toolbar** (`zen.view.use-single-toolbar = true`): the URL bar and nav buttons live **inside the sidebar**, and there is no top toolbar | prefs/zen/view.yaml; ZenUIManager.mjs:1434-1486 [src] |
| Sidebar default width | **186px** (Linux/Windows), **230px** (macOS) | ZenCustomizableUI.sys.mjs:58-59 [src] |
| Sidebar min width | **117px** in single-toolbar mode (Linux/Win; add caption-button width if the sidebar is on the right). macOS 163px. Multi-toolbar mode 36px. | ZenUIManager.mjs:1316-1328 [src] |
| Sidebar max width | **500px** (pref `zen.view.sidebar-expanded.max-width`) | prefs/zen/view.yaml:5-6; ZenUIManager.mjs:1627-1641 [src] |
| Collapsed (icons-only) sidebar | `48px + 2×6px = 60px` | vertical-tabs.css:694-702 [src] |
| Sidebar padding | `padding: 5px; padding-top: 0` | vertical-tabs.css:516-520 [src] |
| Sidebar bg | none of its own. It shows the window background (`#zen-browser-background`, `position:absolute; inset:0` behind everything). | zen-browser-ui.css:37-62; browser-box-inc-xhtml.patch [src] |
| Resize handle | 5px wide (= toolbox padding), on the sidebar's inner edge, `height: calc(100% - 16px); top: 8px; radius 4px`, bg `--zen-accent-button-background`, opacity 0, then `.8` on hover after a 0.2s delay | zen-browser-ui.css:301-319 [src] |
| Content wrapper margin | `margin: 8px; margin-top: 0; margin-left: 0` (left sidebar) | zen-browser-ui.css:170-183 [src] |
| Top strip in single-toolbar mode | `height: 8px` (= separation). Expands to 34px on hover to show the window controls. | zen-tabs.css:23-28; vertical-tabs-topbar.inc.css:7,24-32 [src] |
| Gap sidebar→content | the sidebar's right padding is 5px; tab bgs have a 2px inset (§6), so the visible gap from a tab's edge to the card is about **7px** | [derived] |
| Content card radius | `calc(var(--zen-native-inner-radius) / var(--zen-squircle-value))` with `corner-shape: round`. Here `--zen-native-inner-radius = max(5px, (R − sep/2) × squircle)`. That gives **4px** on Linux (R=8), **5px** Windows, **6px** macOS, **7px** Tahoe. A GTK theme with a 12px CSD radius gives 8px. | zen-theme.css:279-286; zen-browser-container.css:11-16 [derived] |
| Content card border | none (`--zen-appcontent-border` is defined but not used on the card) | [src: grep] |
| Content card shadow | `--zen-big-shadow` | zen-browser-container.css:12 [src] |
| Window min height | 495px | zen-theme.css:307 [src] |

```css
/* Grove equivalents */
:root { --sep: 8px; --sidebar-w: 186px; --toolbox-pad: 5px; --zen-squircle: 1.3; }
.window   { display: flex; height: 100vh; background: var(--zen-main-browser-background); }
.sidebar  { width: var(--sidebar-w); min-width: 117px; max-width: 500px;
            padding: 0 var(--toolbox-pad) var(--toolbox-pad); display: flex; flex-direction: column;
            color: var(--toolbox-textcolor); position: relative; }
.content-area { flex: 1; display: flex; flex-direction: column; margin: 0 var(--sep) var(--sep) 0; }
.content-topstrip { height: var(--sep); transition: height .15s ease-in-out; }
.content-topstrip:hover { height: 34px; }             /* window controls live here on Linux/Win */
.page-card { flex: 1; overflow: clip; border-radius: 4px; corner-shape: round;
             box-shadow: rgba(0,0,0,.24) 0 3px 8px; background: light-dark(#fff, rgb(32,32,32)); }
.sidebar-resizer { position: absolute; right: 0; top: var(--sep); width: var(--toolbox-pad);
                   height: calc(100% - 2*var(--sep)); border-radius: 4px; opacity: 0; cursor: ew-resize;
                   background: var(--zen-accent-button-background); transition: opacity .2s ease-in-out; }
.sidebar-resizer:hover { opacity: .8; transition-delay: .2s; }
```

`--zen-accent-button-background` is
`light-dark(oklch(from var(--zen-primary-color) clamp(.35,l,.6) c h), oklch(from var(--zen-primary-color) clamp(.55,l,.7) c h))`
(zen-buttons.css:87-90).

**Multi-toolbar mode** (not default): the nav bar (back/forward/reload, URL bar, buttons) sits
above the content card at `--zen-toolbar-height: 38px` (mac 42px) (zen-theme.css:154-157).
The sidebar then holds only the top buttons row and the tabs.

---

## 3. Sidebar top area (single-toolbar default)

Order from top to bottom (ZenUIManager.mjs:1467-1483): `#zen-sidebar-top-buttons` row, then
`#nav-bar` (URL bar), then the tab area.

### 3.1 Top buttons row

- Height **36px** (mac 38px); vertical margin `toolbox-padding / 2 = 2.5px` (vertical-tabs.css:1006-1010, 116-117) [src].
- Content, left to right: **app menu `≡`** (`#PanelUI-button`, `order:-2`), the extensions
  button (hidden by default, pref `zen.theme.hide-unified-extensions-button`), the
  **compact-mode toggle** (sidebar icon), a flexible separator, then **back, forward, reload**.
  Extension action buttons also land after the separator. Source: ZenUIManager.mjs:1453-1473;
  ZenCustomizableUI.sys.mjs:88-97; CustomizableUI patch l.23-25 [src].
- On macOS the traffic lights sit at the far left of this row. On Linux/Windows the window
  controls move to the top strip over the content card (ZenUIManager.mjs:1475-1477) [src].
- Buttons: 16px icon, 6px padding, so a **28×28 box**, radius **8px**. Outer margin
  `--toolbarbutton-padding-outer: 1px`. Icon fill is `color-mix(currentColor 70%, transparent)`.
  Hover bg is the 7% tint and active is 10%. Press is `scale(.95)`. Source:
  zen-single-components.css:185-205; zen-theme.css:167-188 [src].

```css
.sidebar-top { height: 36px; margin: 2.5px 0; display: flex; align-items: center; gap: 2px; }
.sidebar-top .spacer { flex: 1; }
.tbtn { width: 28px; height: 28px; padding: 6px; border-radius: 8px; margin: 0 1px;
        color: color-mix(in srgb, currentColor 70%, transparent);
        transition: background-color .1s, transform .2s; }
.tbtn:hover  { background: var(--toolbarbutton-background-color-hover); }
.tbtn:active:hover { background: var(--toolbarbutton-background-color-active); transform: scale(.95); }
.tbtn svg { width: 16px; height: 16px; fill: currentColor; }
```

### 3.2 URL bar in the sidebar

| Property | Value | Source |
|---|---|---|
| Row height | nav-bar `--zen-toolbar-height: 37px` | zen-browser-ui.css:133-136 [src] |
| Outer padding | `#urlbar { padding: 1px }`, `.urlbar-background { margin: 1px }` | zen-omnibox.css:13-16, 71-73 [src] |
| Field height | ≈ **32–34px** | [inferred] (37px row minus padding; upstream `--urlbar-padding-block: 4px`, FF tokens:2247) |
| Background | `var(--zen-toolbar-element-bg)` (≈ 7% black / 13.5% white), `border: none; box-shadow: none; outline: none` | zen-omnibox.css:63-77 [src] |
| Hover bg | `var(--zen-toolbar-element-bg-hover)` (8% black / 10% white) | zen-omnibox.css:86-90 [src] |
| Radius | `var(--border-radius-medium)` = **14px** with squircle | zen-omnibox.css:65 [src] |
| Inner padding | `padding-inline: 4px` on the input container | vertical-tabs.css:544-548 [src] |
| Text | `font-weight: 500`; color = field text at **70%** alpha; `cursor: default` | zen-omnibox.css:130-140 [src] |
| **Domain display** | Shows the **bare host only**: strips `https://`, the path, and a leading `www.` (e.g. `github.com`). Non-https URLs keep their scheme. Pref `zen.urlbar.show-domain-only-in-sidebar = true`. | ZenUIManager.mjs:716-732; prefs/zen/zen-urlbar.yaml [src] |
| Right-side icons (site-data/permissions, page actions, copy-URL) | `opacity: 0; visibility: collapse`. They fade in (`.15s`) **only while the sidebar is hovered**. Icon boxes are 26px min width, radius 8px, padding 5-6px. | zen-omnibox.css:155-177, 119-124, 230-234, 410-414 [src] |
| On click / typing | Floats centered over the page (`zen.urlbar.behavior = floating-on-type`): `width: min(90%, 62rem)`, height 62px, radius **15px**, bg `light-dark(rgba(255,255,255,.93), rgba(20,20,20,.93))` + `backdrop-filter: blur(40px)`, big shadow as in §1.5, `font-size: 1.15em` | zen-omnibox.css:275-301, 478-503 [src] |

```css
.urlbar { height: 34px; margin: 1px; padding: 0 4px; display: flex; align-items: center; gap: 4px;
          background: var(--zen-toolbar-element-bg); border-radius: 14px; }
.urlbar:hover { background: var(--zen-toolbar-element-bg-hover); }
.urlbar .host { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                color: color-mix(in srgb, var(--toolbox-textcolor) 70%, transparent); cursor: default; }
.urlbar .actions { opacity: 0; transition: opacity .15s; }
.sidebar:hover .urlbar .actions { opacity: 1; }
.urlbar .actions button { min-width: 26px; height: 26px; padding: 5px; border-radius: 8px; }
```

```js
// domain-only trim, ported from ZenUIManager.mjs:721-729 (MPL: keep in an MPL file if copied verbatim)
function trimForSidebar(url) {
  let u = url.replace(/\/$/, "");
  let s = u.startsWith("https://") ? u.split("/")[2] : u;
  return s.startsWith("www.") ? s.slice(4) : s;
}
```

---

## 4. Essentials (pinned grid tiles)

| Property | Value | Source |
|---|---|---|
| Container placement | above the workspace indicator. The grid bleeds out by the toolbox padding: `margin-left: -5px; width: calc(100% + 10px); padding: 0 5px` | vertical-tabs.css:1086-1090, 1116-1118 [src] |
| Container padding (single toolbar) | `padding-top: 6px; padding-bottom: 2px` when not empty | vertical-tabs.css:1123-1126 [src] |
| Grid | `display:grid; gap: 4px; grid-template-columns: repeat(auto-fit, minmax(max(23.7%, 50px), 1fr))`, so **up to 4 per row** | vertical-tabs.css:1096-1105 [src] |
| Grid balancing hacks | 6 or 9 tiles: `minmax(max(30%,50px), auto)` (3 cols). 2 or 4 tiles: two `minmax(max(23%,50px),1fr)` tracks repeated (2 cols). 5 tiles: `minmax(max(25%,48px),1fr)` | vertical-tabs.css:1106-1114; ZenSpaceManager.mjs:2860-2870 [src] |
| Tile height | `--tab-min-height: 46px` for the tile background. The row adds `2px` block margin top and bottom. | vertical-tabs.css:572-574, 305 [src] |
| Tile radius | `14px` (+ squircle) | vertical-tabs.css:1144-1146 [src] |
| Unselected bg | `var(--zen-toolbar-element-bg)` (≈ 7% black / 13.5% white), no border | vertical-tabs.css:1150-1153 [src] |
| Hover (unselected) | `light-dark(rgba(0,0,0,.1), rgba(255,255,255,.2))` | vertical-tabs.css:1148, 1170-1172 [src] |
| Content | favicon only, centered. No label, no close button. | vertical-tabs.css:1155-1168 [src] |
| Favicon size | 16px, radius 4px | [inferred: upstream default] ; vertical-tabs.css:353 [src radius] |
| **Selected** (pref `zen.theme.essentials-favicon-bg = true`) | The tile bg becomes transparent. Its `::after` is the **favicon itself**, scaled to `inset:-50%`, `background-size: contain`, `filter: blur(20px)`, `z-index:-1`: a colored glow. Its `::before` is an inset plate `margin: 2px; radius: 12px`, bg `light-dark(rgba(255,255,255,.85), rgba(68,64,64,.85))` for the default theme (themed dark: `color-mix(in srgb, var(--zen-primary-color), rgba(132,132,132,.85) 40%)`). The glow therefore shows as a colored **2px rim** plus a tint through the plate. | vertical-tabs.css:1174-1218 [src] |
| Selected hover | plate becomes `light-dark(rgba(255,255,255,.8), rgba(68,64,64,.75))` (themed dark: 30% mix), `transition: background .1s ease-in-out` | vertical-tabs.css:1199-1203, 1220-1222 [src] |
| Audio indicator | a small overlay badge on the favicon corner (only essentials use the overlay) | tabs-css.patch (`&[zen-essential]:is([soundplaying],[muted],…)`) [src] |
| Collapsed sidebar | single column (`grid-template-columns: 1fr`) | vertical-tabs.css:728-735 [src] |
| Transition | `max-height .3s ease-out, grid-template-columns .3s ease-out` | vertical-tabs.css:1100-1102 [src] |

```css
.essentials { display: grid; gap: 4px; padding: 6px 5px 2px; margin-inline: -5px;
              grid-template-columns: repeat(auto-fit, minmax(max(23.7%, 50px), 1fr)); }
.essentials[data-count="2"], .essentials[data-count="4"] {
  grid-template-columns: repeat(auto-fit, minmax(max(23%, 50px), 1fr) minmax(max(23%, 50px), 1fr)); }
.essentials[data-count="6"], .essentials[data-count="9"] {
  grid-template-columns: repeat(auto-fit, minmax(max(30%, 50px), auto)); }
.essentials[data-count="5"] { grid-template-columns: repeat(auto-fit, minmax(max(25%, 48px), 1fr)); }

.essential-tile { position: relative; height: 46px; margin-block: 2px; border-radius: 14px;
                  display: grid; place-items: center; overflow: hidden; isolation: isolate;
                  background: var(--zen-toolbar-element-bg); transition: scale .1s ease; }
.essential-tile:hover { background: light-dark(rgba(0,0,0,.1), rgba(255,255,255,.2)); }
.essential-tile:active { scale: .985; }
.essential-tile img { width: 16px; height: 16px; border-radius: 4px; z-index: 1; }
.essential-tile.selected { background: transparent; }
.essential-tile.selected::after {            /* glow = blurred favicon */
  content: ""; position: absolute; inset: -50%; z-index: -1; filter: blur(20px);
  background: var(--favicon) center / contain no-repeat; }   /* set --favicon: url(...) inline */
.essential-tile.selected::before {           /* 2px-inset plate */
  content: ""; position: absolute; inset: 0; margin: 2px; border-radius: 12px; z-index: 0;
  background: light-dark(rgba(255,255,255,.85), rgba(68,64,64,.85)); transition: background .1s ease-in-out; }
.essential-tile.selected:hover::before { background: light-dark(rgba(255,255,255,.8), rgba(68,64,64,.75)); }
```

---

## 5. Pinned vs normal tabs, separator, "+ New Tab"

Each workspace renders this structure (ZenSpace.mjs `markup`):
`indicator`, then `pinned-tabs-section` (with the separator as its last child), then
`normal-tabs-section` (whose first child is the "+ New Tab" row).

- **Pinned tabs look the same as normal tabs**: full-width rows with favicon and title, same
  metrics (§6). Differences:
  - No close button unless the tab is unloaded (vertical-tabs.css:877-879).
  - A **reset/unpin button** (`unpin.svg`) appears on hover or when selected
    (vertical-tabs.css:881-899). Default shortcut behaviour is `reset-unload-switch`, so the icon
    is "unpin". It only becomes "close" when the pref is `close` (icons.css:67-73).
  - When the pinned tab has navigated away from its pinned URL (`zen-pinned-changed`), the
    favicon area becomes a clickable "back to pinned URL" button. It shows the original
    favicon plus a slanted divider (`2.5px × 16px`, `rotate(15deg)`,
    `light-dark(rgba(66,61,61,.3), rgba(255,255,255,.3))`). On hover the sublabel "Back to
    pinned url" fades in (vertical-tabs.css:637-667, 921-959).
- **Separator** `.pinned-tabs-container-separator` (vertical-tabs.css:136-228):
  - `height: 22px`, contains a `1px` line `light-dark(rgba(0,0,0,.1), rgba(255,255,255,.1))`
    with `margin: auto 4px` (mac adds `padding: 0 5px`).
  - Hidden (`height:0; opacity:0`) when there are no pinned tabs (`hide-separator`).
    Transition `height .08s, padding .08s, opacity .06s ease-in-out`.
  - Right side: a "Clear" button (`dart-down` icon 10px + text, `10px/500`) that removes
    unpinned tabs. It is invisible until the sidebar is hovered (then `opacity .5`, `1` on its
    own hover). On press the icon shifts `translateY(2px)`.
- **Collapse pinned**: hovering the workspace indicator swaps its icon for a chevron
  (`rotate(90deg)` = open, `0deg` = collapsed). Clicking it collapses the pinned section
  with the folder animation (zen-workspaces.css:431-475; ZenSpace.mjs nsZenCollapsiblePins).
- **"+ New Tab" row** `#tabs-newtab-button` (shown at the **top** of the normal tabs, pref
  `zen.view.show-newtab-button-top = true`, vertical-tabs.css:1070-1079):
  - Row metrics match a tab: `width:100%`, `min-height: 36px`, `max-height: var(--tab-min-height)`,
    radius 14px, `padding-inline: 8px`, icon `plus` 16×16, label "New Tab"
    (vertical-tabs.css:582-615, 1044-1068; tabs-css.patch l.2640-2665).
  - Text/icon color `color-mix(in srgb, currentColor 70%, transparent)` (vertical-tabs.css:1315-1318).
  - Hover bg is the tab hover tint. Press is `scale(.985)` over `.1s ease`.
  - When the URL bar is open for a new tab (`[in-urlbar]`), it takes the **selected-tab look**
    (bg + shadow) (vertical-tabs.css:1063-1067).

```css
.pinned-section, .normal-section { display: flex; flex-direction: column; padding: 0 5px; }
.tab-separator { height: 22px; display: flex; align-items: center; gap: 4px; overflow: hidden;
                 transition: height .08s ease-in-out, opacity .06s ease-in-out; }
.tab-separator.hidden { height: 0; opacity: 0; }
.tab-separator hr { flex: 1; height: 1px; border: 0; margin: auto 4px;
                    background: light-dark(rgba(0,0,0,.1), rgba(255,255,255,.1)); }
.tab-separator .clear { font-size: 10px; font-weight: 500; display: flex; gap: 2px; align-items: center;
                        opacity: 0; visibility: hidden; transition: opacity .15s, visibility .15s; }
.sidebar:hover .tab-separator .clear { opacity: .5; visibility: visible; }
.tab-separator .clear:hover { opacity: 1; }
.tab-separator .clear svg { width: 10px; transition: transform .15s ease-in-out; }
.tab-separator .clear:active:hover svg { transform: translateY(2px); }

.newtab-row { /* reuse .tab metrics */ color: color-mix(in srgb, currentColor 70%, transparent); }
```

---

## 6. Vertical tab row

Box model: the row has `margin-block: 2px` around the background (FF tabs.css:1051). The
background has `min-height: 36px` (FF tabs.css:34), `margin-inline: 2px` (vertical-tabs.css:630-633),
and `radius: 14px` (vertical-tabs.css:367-370). Content has `padding: 0 8px`. The favicon gets
`margin-inline-start: 10/3 ≈ 3.33px` and `margin-inline-end: 10px` (vertical-tabs.css:682-689).
Row pitch = 36 + 2 + 2 = **40px**.

| Property | Value | Source |
|---|---|---|
| Tab bg height | **36px** (`--tab-min-height`, non-Nova Firefox; Nova is locked off) | FF tabs.css:32-34; prefs/firefox/browser.yaml:116-118 [src] |
| Vertical margin | **2px** top and bottom | vertical-tabs.css:305 [src] |
| Horizontal inset of bg | **2px** each side (inside the 5px section padding) | vertical-tabs.css:630-633; 1309-1312 [src] |
| Radius | **14px** + squircle 1.3 | vertical-tabs.css:235, 369 [src] |
| Content padding | `0 8px` | vertical-tabs.css:619; FF tabs.css:352 [src] |
| Favicon | 16×16, radius 4px; `margin: 0 10px 0 3.33px` | vertical-tabs.css:350-353, 527, 686-689 [src] |
| Missing favicon | a 16px square filled `color-mix(in srgb, var(--zen-primary-color) 80%, light-dark(#000,#fff))` at opacity .5 | vertical-tabs.css:355-360 [src] |
| Label | `white-space: nowrap`; line-height 1.7; weight normal | FF tabs.css:986-990 [src] |
| Label overflow | **fade, not ellipsis**: `mask-image: linear-gradient(to left, transparent, black 1em)` when the text overflows | FF tabs.css:964-983, 271 [src] |
| Text color | `--toolbox-textcolor` (selected: FF `--tab-text-color-selected` `light-dark(rgb(21,20,26), #fff)`) | zen-workspaces.css:335; FF tokens:2833-2845 [src] |
| **Hover** | bg `--tab-background-color-hover` (7% tint) | zen-theme.css:266; FF tabs.css:1057-1060 [src] |
| **Selected** | bg `--tab-background-color-selected` + `--tab-box-shadow-selected` (see §1.4); no border | zen-workspaces.css:337-341; FF tabs.css:1062-1066; vertical-tabs.css:901-903 [src] |
| **Press** | `scale: .985; rotate: .01deg` (GPU hint), `transition: scale .1s ease` | vertical-tabs.css:314-342 [src] |
| **Close button** | 24×24, `padding: 4px` (16px glyph box; FF glyph is `close-12.svg`), radius **8px**. **Shown only on hover** (also on the selected tab of a multi-selection). `margin-inline-end: 0`. Hover bg is FF ghost-button hover (≈ `currentColor` 10%) [inferred]. | vertical-tabs.css:669-680, 907-919; zen-theme.css:227; FF tabs.css:995-1016 [src] |
| Audio button | appears after the favicon when playing/muted: 24px button, `margin-inline: -4px 2px; margin-top: -1px`. Icons `tab-audio-playing-small` / `-muted-small` / `-blocked`. | vertical-tabs.css:531-535; FF tabs.css:925-958; tabs-css.patch [src] |
| **Multi-select** | same bg and shadow as selected. Firefox's focus-outline ring is disabled because Zen sets `--focus-outline-color: transparent` on the tab list. | FF tabs.css:1062-1090; vertical-tabs.css:290 [src] |
| **Unloaded/discarded** | favicon only: `opacity: .5` with a 1s transition. Zen removes Firefox's grayscale filter. Label unchanged. | tabs-css.patch l.572-597; prefs/firefox/browser.yaml:17-18 [src] |
| Loading throbber | hidden (`zen.theme.hide-tab-throbber = true`), favicon stays | vertical-tabs.css:1320-1328 [src] |
| Container color line | hidden for the default container | zen-tabs.css:14-18 [src] |
| Sublabel | second line `x-small`, `opacity .5`, `max-height 0→10px` (.1s ease-in-out) | vertical-tabs.css:496-514 [src] |
| Scroll overflow | 1px hairlines at the top/bottom edges when the list can scroll (§1.4). Bottom padding `calc(36px*3 + 2px*4)` = 116px so the last tabs clear the foot | zen-workspaces.css:361-408 [src] |
| Scrollbar | `scrollbar-color: color-mix(in srgb, currentColor 35%, transparent) transparent` | zen-workspaces.css:363 [src] |

**Drag feedback** (vertical-tabs.css:1226-1269, 332-334, 1332-1343):
- Drop indicator: a `2px` line, color
  `color-mix(in srgb, var(--zen-primary-color) 50%, light-dark(rgba(0,0,0,.85), rgba(255,255,255,.95)) 50%)`,
  `border-radius: 5px`. It has a **ring** at its start (a 4×4 circle with a 2px border in the same
  color, i.e. a hollow dot). It starts `2*2+4 = 8px` in from the list's left edge.
- The dragged tab image uses radius `14px / 1.3`.
- The drop target in the workspace/sidebar is tinted with `--zen-primary-color` (`#zen-dragover-background`).

```css
.tab { position: relative; display: flex; align-items: center; min-height: 36px;
       margin: 2px 2px; padding: 0 8px; border-radius: 14px; color: var(--toolbox-textcolor);
       transition: scale .1s ease, margin-inline-start .1s ease-in-out; }
.tab:hover { background: var(--tab-background-color-hover); }
.tab.selected, .tab.multiselected { background: var(--tab-background-color-selected);
                                    box-shadow: var(--tab-box-shadow-selected); }
.tab:active { scale: .985; }
.tab .favicon { width: 16px; height: 16px; border-radius: 4px; margin: 0 10px 0 3.33px; flex: none; }
.tab .favicon:active { scale: .97; }
.tab.discarded .favicon { opacity: .5; transition: opacity 1s; }
.tab .label { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; line-height: 1.7; }
.tab .label.overflowing { mask-image: linear-gradient(to left, transparent, black 1em); }
.tab .close { display: none; width: 24px; height: 24px; padding: 4px; border-radius: 8px; flex: none; }
.tab:hover .close, .tab.multiselected.selected .close { display: block; }
.tab .close:hover  { background: color-mix(in srgb, currentColor 10%, transparent); }
.tab .close:active { background: color-mix(in srgb, currentColor 20%, transparent); }
.tab .audio { width: 24px; height: 24px; padding: 4px; margin: -1px 2px 0 -4px; }

.drop-indicator { position: fixed; height: 2px; border-radius: 5px; pointer-events: none;
  --c: color-mix(in srgb, var(--zen-primary-color) 50%, light-dark(rgba(0,0,0,.85), rgba(255,255,255,.95)) 50%);
  background: var(--c); }
.drop-indicator::before { content: ""; position: absolute; left: -4px; top: 50%; width: 4px; height: 4px;
  transform: translate(-2px, -50%); border: 2px solid var(--c); border-radius: 50%; }
```

---

## 7. Folders

| Property | Value | Source |
|---|---|---|
| Header row height | `2×2px + 36px = 40px` (same pitch as a tab) | zen-folders.css:78 [src] |
| Header padding | `padding-inline: 4px` (FF `--tab-group-label-padding`); end padding doubled (8px) when expanded | zen-folders.css:79-83; FF tabs.css:52 [src] |
| Header outer margin | `margin: 0 2px; margin-inline-end: 0` | zen-folders.css:68-69 [src] |
| Hover | `::before` inset 2px (`top/left 2px; width/height calc(100% - 4px)`), radius 14px, bg = tab hover tint | zen-folders.css:142-156 [src] |
| Folder containing the selected tab | header `::before` bg `--zen-toolbar-element-bg-hover` | zen-folders.css:32-34 [src] |
| Label | weight **600**, `padding-left: 32px`, color `--toolbar-color` | zen-folders.css:162-177 [src] |
| Icon box | 28×28, absolute at `left: 5px`, vertically centered; svg `filter: contrast(125%)`, `translate(-1px,-1px)` | zen-folders.css:92-105 [src] |
| **Child indent** | `margin-inline-start: 14px` per nesting level (JS: `level × 14px`), animated `.1s ease-in-out` | zen-folders.css:53-57; ZenFolders.mjs:1108-1128; zen-theme.css:204 [src] |
| Max nesting | 5 subfolders | prefs/zen/folders.yaml [src] |
| Collapse | children animate `opacity 1→0, height auto→0` over **180ms ease-in-out**; the group start slides `marginTop → -(collapsedHeight+4)`. **The active tab stays visible** under a collapsed folder (`has-active`). The icon then shows three dots instead of the inner icon. | ZenFolders.mjs:1725-1753; zen-folders.css:128-138 [src] |

**Folder icon** (inline SVG in `zen/folders/ZenFolder.mjs:28-63`, MPL; 28×28, viewBox 0 0 27 27):
- `.back`: a folder silhouette with a tab at top-left
  (`M8 5.625H11.9473…C13.0105 5.80861 13.4316 6.14551 L14.2881 6.83105 … H20 … V20 … H8 … V8 Z`).
  Drawn twice: once filled `--zen-folder-behind-bgcolor`, once stroked 1.5px `--zen-folder-stroke`
  with a white-to-black vertical gradient at `fill-opacity:.1` for sheen.
- `.front`: `rect x=5.625 y=9.625 w=16.75 h=12.75 rx=2.375`, drawn as fill
  `--zen-folder-front-bgcolor` plus a 1.5px stroke and gradient sheen.
- `.icon`: optional 11×11 user icon at `translate(8.5px,10.5px)`, fill
  `color-mix(in srgb, var(--zen-folder-stroke) 50%, currentColor)` at .9 opacity.
- `.dots`: three r=1.25 circles at (10,16), (14,16), (18,16), fill `--zen-folder-stroke`. Shown instead
  of `.icon` when collapsed with an active tab.
- **Open state** (`state="open"`): `.back { transform: skewX(16deg) translate(-4px,2px) scale(.85) }`
  and `.front,.dots,.icon { transform: skewX(-16deg) translate(8px,2px) scale(.85) }`, so the front
  flap tilts open. Transition `.3s cubic-bezier(0.42,0,0,1)` (zen-folder-icon.inc.css:5-18).

Colors (zen-folders.css:15-17):
```css
.folder {
  --zen-folder-behind-bgcolor: light-dark(color-mix(in srgb, var(--zen-primary-color) 60%, gray),
                                          color-mix(in srgb, var(--zen-primary-color) 60%, #c1c1c1));
  --zen-folder-front-bgcolor:  light-dark(color-mix(in srgb, var(--zen-primary-color), white 70%),
                                          color-mix(in srgb, var(--zen-primary-color), black 40%));
  --zen-folder-stroke:         light-dark(color-mix(in srgb, var(--zen-primary-color) 50%, black),
                                          color-mix(in srgb, var(--zen-colors-primary) 15%, #ebebeb));
}
.folder-header { position: relative; height: 40px; margin: 0 0 0 2px; padding-inline: 4px 8px;
                 display: flex; align-items: center; font-weight: 600; }
.folder-header::before { content: ""; position: absolute; inset: 2px; border-radius: 14px; z-index: -1; }
.folder-header:hover::before { background: var(--tab-background-color-hover); }
.folder.has-selected > .folder-header::before { background: var(--zen-toolbar-element-bg-hover); }
.folder-header .folder-icon { position: absolute; left: 5px; width: 28px; height: 28px; pointer-events: none; }
.folder-header .label { padding-left: 32px; flex: 1; overflow: hidden; white-space: nowrap; }
.folder-children > * { margin-inline-start: 14px; transition: margin-inline-start .1s ease-in-out; }
.folder-icon :is(g, rect, path) { transition: transform .3s cubic-bezier(.42,0,0,1), opacity .3s cubic-bezier(.42,0,0,1); }
.folder.open .folder-icon .back { transform: skewX(16deg) translate(-4px, 2px) scale(.85); }
.folder.open .folder-icon :is(.front, .dots, .icon) { transform: skewX(-16deg) translate(8px, 2px) scale(.85); }
.folder-icon .dots { opacity: 0; }  .folder.collapsed.has-active .folder-icon .dots { opacity: 1; }
.folder.collapsed.has-active .folder-icon .icon { opacity: 0; }
```
Note: because the SVG uses `transform` on child elements, set `transform-box: fill-box` or
`transform-origin` explicitly in Chromium. Gecko's default for SVG is `view-box` origin 0,0.
Keep the default (`transform-origin: 0 0`) to match Zen [inferred].

---

## 8. Workspaces

### 8.1 Workspace indicator (header above the pinned tabs)

| Property | Value | Source |
|---|---|---|
| Height | **44px** (38px when the sidebar is collapsed) | zen-theme.css:232-236; zen-workspaces.css:184-185 [src] |
| Padding | `calc(3px + 8px + 5px) = 16px` start; `padding-right: 12px` | zen-workspaces.css:181, 192 [src] |
| Layout | row: `[icon 16px] gap 5px [name flex:1, ellipsis] [⋯ actions]` | zen-workspaces.css:180-191, 224-280 [src] |
| Gap | `--toolbarbutton-padding-inner - 1px`, 5px in the header context | [derived] zen-workspaces.css:180 |
| Icon | 16×16 emoji or SVG; svg fill `--zen-sidebar-themed-icon-fill`; emoji color `light-dark(rgba(0,0,0,.8), rgba(255,255,255,.8))` | zen-workspaces.css:224-236 [src] |
| No icon | the icon is hidden and the name shifts left (`margin-inline-end: -21px`) | vertical-tabs.css:555-557; zen-workspaces.css:439-441 [src] |
| Name | `font-size: small; font-weight: 600`, color **70%** currentColor | zen-workspaces.css:191, 260-280; vertical-tabs.css:1315-1318 [src] |
| Hover / menu-open | `::before` plate `top: 4px; left: 7px; width: calc(100% - 12.5px); height: calc(100% - 8px)`, radius 14px, bg = tab hover tint | zen-workspaces.css:195-222 [src] |
| Actions `⋯` button | `menu.svg`, a 26px box (radius `max(14-4, 4) = 10px`), `opacity 0` until the indicator is hovered (`.1s`) | zen-workspaces.css:282-323 [src] |
| Collapse chevron | 16px chevron replaces the icon on hover when there are pinned tabs; `rotate(90deg)` expanded, `0` collapsed; `.1s` | zen-workspaces.css:431-475 [src] |

```css
.workspace-indicator { position: relative; height: 44px; display: flex; align-items: center; gap: 5px;
                       padding: 0 12px 0 16px; font-size: 13px; font-weight: 500; }
.workspace-indicator::before { content: ""; position: absolute; top: 4px; bottom: 4px; left: 7px; right: 5.5px;
                               border-radius: 14px; pointer-events: none; }
.workspace-indicator:hover::before, .workspace-indicator.open::before { background: var(--tab-background-color-hover); }
.workspace-indicator .icon { width: 16px; height: 16px; font-size: 16px; display: grid; place-items: center;
                             fill: var(--zen-sidebar-themed-icon-fill); }
.workspace-indicator .name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                             color: color-mix(in srgb, currentColor 70%, transparent); }
.workspace-indicator .actions { width: 26px; height: 26px; border-radius: 10px; opacity: 0; transition: opacity .1s; }
.workspace-indicator:hover .actions { opacity: 1; }
```

### 8.2 Workspace switcher (sidebar foot)

Foot toolbar `#zen-sidebar-foot-buttons` (zen-sidebar-icons.inc.xhtml): **[library/downloads]
[workspace icons, flex] [+ create-new]**. Style: `display:flex; justify-content: space-between;
gap: 4px; align-items:center; width:100%` (vertical-tabs.css:455-468, 565-570). The side buttons are
standard 28px toolbar buttons. The `+` has radius 8px and uses the hover tint (icons.css:900-910).

| Property | Value | Source |
|---|---|---|
| Strip | `display:flex; justify-content:center; gap: .5ch` (≈3px), `overflow-x:auto; scrollbar-width:none; scroll-behavior:smooth` | zen-workspaces.css:9-29, 168-175 [src] |
| Button | **30×30** (mac 32), radius **8px**, `padding:0` | zen-workspaces.css:31-49; zen-single-components.css:188-189 [src] |
| Inactive | `filter: grayscale(1); opacity: .7` | zen-workspaces.css:78-79 [src] |
| Active | `grayscale(0); opacity:1`; svg fill `--zen-sidebar-themed-icon-fill` at full opacity. **No background** on the active item. | zen-workspaces.css:86-96 [src] |
| Hover | `grayscale(0); opacity 1; background: var(--zen-toolbar-element-bg)` | zen-workspaces.css:91-101 [src] |
| Transition | `filter .2s, opacity .2s, width .1s, transform .2s` | zen-workspaces.css:80-84 [src] |
| No-icon workspace | an **8px dot**, `light-dark(rgba(0,0,0,.4), rgba(255,255,255,.4))` | zen-workspaces.css:70-75 [src] |
| Overflow (too many) | gap 0; non-active icons shrink to **4px dots** (`min-width:10px`), dot color `color-mix(in srgb, var(--zen-primary-color) 10%, light-dark(rgba(0,0,0,.4), rgba(255,255,255,.4)) 90%)`; the icon scales `0→1` on hover (150ms) | zen-workspaces.css:117-137; overflow-icons.inc.css:7-43 [src] |

```css
.sidebar-foot { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.workspace-switcher { flex: 1; display: flex; justify-content: center; gap: .5ch;
                      overflow-x: auto; scrollbar-width: none; scroll-behavior: smooth; }
.workspace-switcher button { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center;
  font-size: 12px; filter: grayscale(1); opacity: .7;
  transition: filter .2s, opacity .2s, width .1s, transform .2s; }
.workspace-switcher button:hover { filter: none; opacity: 1; background: var(--zen-toolbar-element-bg); }
.workspace-switcher button.active { filter: none; opacity: 1; }
.workspace-switcher button.active svg { fill: var(--zen-sidebar-themed-icon-fill); }
.workspace-switcher button.no-icon::after { content: ""; width: 8px; height: 8px; border-radius: 50%;
  background: light-dark(rgba(0,0,0,.4), rgba(255,255,255,.4)); }
```

### 8.3 Per-workspace theme: gradient background

The theme is stored per workspace as `{ type:"gradient", gradientColors:[{c:[r,g,b], isPrimary, isCustom, …}], opacity, texture }`
(ZenGradientGenerator.mjs:1433-1440). The default opacity slider value is **0.4**. The range is
**0.25–0.8** on Linux/Windows and 0.30–0.8 on macOS (theme-picker.inc:132-139).

**Where it is applied.** `getGradient(colors)` returns a CSS `background` value. It is written to
`--zen-main-browser-background` on `#zen-browser-background`, an `absolute; inset:0` layer
behind the entire browser (the sidebar and the gaps around the card) (ZenGradientGenerator.mjs:1727-1752;
zen-browser-ui.css:37-62). The same function with `forToolbar=true` feeds
`--zen-main-browser-background-toolbar`, which is only visible on the floating compact-mode
sidebar (§9). The **sidebar has no separate background in normal mode**: the gradient shows through.

**Algorithm** (opaque platforms, i.e. Linux without transparency and Windows without Mica):
1. `base = dark ? [23,23,26] : [240,240,244]` (`getToolbarModifiedBaseRaw`, :1235-1238).
2. For each color `c`: `blend(c, base, opacity×100%)`, i.e. `c×opacity + base×(1−opacity)`, fully
   opaque (`#getSingleRGBColor`, :1284-1306; `blendColors` :1326-1333).
3. Composition with `rotation = -30`:
   - **0 colors** gives `#e9e9e9` / `#131313` (sidebar-only variant: `rgb(240,240,244)` / `rgb(23,23,26)`).
   - **1 color** gives that solid color.
   - **2 colors**: `linear-gradient(150deg, C0 30%, transparent 120%), linear-gradient(-30deg, C1 30%, transparent 120%)`.
     The code reverses the pair, so C0's layer is on top. The toolbar variant is `linear-gradient(-30deg, C1 0%, C0 100%)`.
   - **3 colors**: `linear-gradient(-5deg, C2 10%, transparent 80%), radial-gradient(circle at 95% 0%, C1 0%, transparent 75%), radial-gradient(circle at 0% 0%, C0 10%, transparent 70%)`.
   - **custom colors**: `linear-gradient(-30deg, c0 0%, …, cn 100%)` with even stops (:1353-1366).
4. The layer also has `background-blend-mode: lighten` (zen-browser-ui.css:61). Workspace switches
   cross-fade an `-old` layer via `--zen-background-opacity` (zen-browser-ui.css:57-75).
5. **Grain**: `.zen-browser-grain` is a tiled `grain-bg.png` at `opacity = texture` (0–1)
   (zen-browser-ui.css:87-104). The texture PNG is in Zen's images. Generate your own noise instead
   of copying the asset [inferred].
6. **Accent from the theme**: dominant color `[r,g,b]`, then `--zen-primary-color`. In dark mode it is used
   as-is. In light mode it is converted to HSL, `s = min(1, s + .3)`, `l = l×.4 + .42×.6`
   (:1478-1493).
7. **Text color**: `rgba(0,0,0,.9)` or `rgba(255,255,255,.9)`, blended **5%** toward the dominant color
   (20% on transparent platforms) (:1504-1516). Light vs dark is chosen by WCAG contrast of each
   candidate against the blended bg (:1393-1431). The result sets `zen-should-be-dark-mode`, which
   forces `color-scheme` on the sidebar (zen-theme.css:347-353).

```js
// Grove port of the gradient (opaque path). Algorithm per ZenGradientGenerator.mjs (MPL).
function wsBackground(colors, opacity = 0.4, dark) {
  const base = dark ? [23,23,26] : [240,240,244];
  const mix = c => `rgb(${c.map((v,i)=>Math.round(v*opacity + base[i]*(1-opacity))).join(",")})`;
  if (!colors.length) return dark ? "#131313" : "#e9e9e9";
  if (colors.length === 1) return mix(colors[0]);
  if (colors.length === 2) return `linear-gradient(150deg, ${mix(colors[0])} 30%, transparent 120%), ` +
                                  `linear-gradient(-30deg, ${mix(colors[1])} 30%, transparent 120%)`;
  const [c0,c1,c2] = colors.map(mix);
  return `linear-gradient(-5deg, ${c2} 10%, transparent 80%), ` +
         `radial-gradient(circle at 95% 0%, ${c1} 0%, transparent 75%), ` +
         `radial-gradient(circle at 0% 0%, ${c0} 10%, transparent 70%)`;
}
```
```css
.window-bg { position: absolute; inset: 0; z-index: 0; pointer-events: none;
             background: var(--zen-main-browser-background); background-blend-mode: lighten; }
```

---

## 9. Compact mode (sidebar hidden, hover reveal)

Enabled with the sidebar toggle button (`#zen-toggle-compact-mode`). Default hides only the sidebar
(`zen.view.compact.hide-tabbar = true`, `hide-toolbar = false`) (prefs/zen/compact-mode.yaml).

| Property | Value | Source |
|---|---|---|
| Sidebar becomes | `position: fixed; z-index: 10`, floating **inside** the window: `top: float/2 = 4px`, `height: calc(100% - 8px)`, `left: -4px`, `width: sidebar + 2×8px`, `padding: 0 8px` (`--zen-compact-float` = separation 8px) | compact-mode/sidebar.inc.css:49-115 [src] |
| Hidden position | `translate: calc(-1 × (sidebarWidth + 8px − 1px))`. About **5px** of the panel stays inside the window edge, and that sliver is the **hover trigger zone** (plus leaving the window across the left edge within the panel's y-range ±7px) | compact-mode/sidebar.inc.css:67-82; ZenCompactMode.mjs:854-905 [derived] |
| Floating panel look | `#titlebar` padding 5px. `.zen-toolbar-background` is shown: radius = native inner radius (≈5.2px on Linux; *not* divided by squircle), bg = toolbar gradient (`--zen-main-browser-background-toolbar`, `background-attachment: fixed; background-size: 100vw 100vh` so it lines up with the window gradient), `box-shadow: var(--zen-big-shadow)`, `outline: 1px solid rgba(255,255,255,.15); outline-offset: -1px` | zen-compact-mode.css:8-30; sidebar.inc.css:143-161 [src] |
| Acrylic (pref on by default) | while shown: `background: transparent; backdrop-filter: blur(42px) saturate(110%) brightness(.25) contrast(100%)` | sidebar.inc.css:277-282; prefs/zen/theme.yaml:20-21 [src] |
| Show animation | `translate → none` over **.25s** with the spring `linear()` curve (overshoot ≈1.1%). Copy the stops from sidebar.inc.css:171-273 or approximate with `cubic-bezier(.2,.9,.3,1.02)` [inferred] | sidebar.inc.css:171-291 [src] |
| Hide animation | `translate .15s ease, visibility .15s ease` | sidebar.inc.css:81-84 [src] |
| Keep-open delay after mouse leaves | **150ms** (`sidebar-keep-hover.duration`). The top toolbar uses **1000ms**. | prefs/zen/compact-mode.yaml; ZenCompactMode.mjs:622-637 [src] |
| Stays open while | hovered, a popup/menu is open, a tab is dragged, a tab is being renamed, empty-tab URL bar | sidebar.inc.css:163-170 [src] |
| Content card | fills the window with 8px margins on both sides | sidebar.inc.css:19-23 [src] |

```css
.sidebar.compact { position: fixed; z-index: 10; top: 4px; left: -4px; height: calc(100% - 8px);
  width: calc(var(--sidebar-w) + 16px); padding: 0 8px;
  translate: calc(-1 * (var(--sidebar-w) + 8px - 1px));
  transition: translate .15s ease, visibility .15s ease; }
.sidebar.compact.revealed { translate: none; transition: translate .25s cubic-bezier(.2,.9,.3,1.02); }
.sidebar.compact .panel { position: absolute; inset: 0 8px; border-radius: 5px;
  background: var(--zen-main-browser-background-toolbar) fixed; background-size: 100vw 100vh;
  box-shadow: rgba(0,0,0,.24) 0 3px 8px; outline: 1px solid rgba(255,255,255,.15); outline-offset: -1px; }
@supports (backdrop-filter: blur(1px)) {
  .sidebar.compact.revealed .panel { background: transparent;
    backdrop-filter: blur(42px) saturate(110%) brightness(.25); }   /* note: brightness(.25) is Zen's; tune for light mode */
}
```
In a WebUI page the web content is a separate surface (e.g. a `<webview>`/native view), so
`backdrop-filter` will not blur the page behind the panel [inferred]. Use the opaque toolbar
gradient in that case.

---

## 10. Icons

**Do not copy `src/browser/themes/shared/zen-icons/nucleo/*.svg`** (Nucleo license, see §0).
These are the files Zen uses, so you can match the look:

| Use | Zen file (Nucleo, reference only) | Mapping source |
|---|---|---|
| Back / Forward | `zen-icons/nucleo/back.svg`, `forward.svg` | icons.css:27-33 |
| Reload / Stop | `nucleo/reload.svg`; stop = `close.svg` | icons.css:35-46 |
| New tab / create-new `+` | `nucleo/plus.svg` (18×18, 1.5px round-cap strokes drawn as a filled path) | icons.css:211-219 |
| Close | `nucleo/close.svg` (tab close falls back to Firefox `close-12.svg`) | icons.css:39-46; FF tabs.css:997 |
| Unpin / reset pinned | `nucleo/unpin.svg` | icons.css:67-73 |
| App menu / workspace `⋯` | `nucleo/menu.svg` | icons.css:142-146 |
| Compact-mode toggle | `nucleo/sidebar.svg` (`sidebar-right.svg` when on the right) | icons.css:81-87 |
| Downloads | `nucleo/downloads.svg` | icons.css:89-93 |
| Folder (menus) | `nucleo/folder.svg` | icons.css:445 |
| Clear unpinned tabs | `nucleo/dart-down.svg` | icons.css:399-409 |
| Audio playing/muted | `nucleo/tab-audio-playing-small.svg`, `tab-audio-muted-small.svg` | jar.inc.mn |
| Workspace chevron | `nucleo/chevron.svg` | icons.css:10,132 |

**Reusable alternatives:**
- **Sidebar folder icon**: the inline SVG in `zen/folders/ZenFolder.mjs:28-63` is Zen's own MPL
  code. You can reuse it inside the MPL-headed file (§7).
- **Workspace icon set**: `zen-icons/common/selectable/*.svg` (88 Ionicons, **MIT**), e.g. `folder.svg`,
  `globe.svg`, `code.svg`, `terminal.svg`, `briefcase.svg`, `star.svg`.
- **Firefox's own MPL icons** from mozilla-central (not in this repo):
  `toolkit/themes/shared/icons/{plus.svg, close.svg, close-12.svg, arrow-left.svg, arrow-right.svg, reload.svg, more.svg, chevron.svg, folder.svg}`
  and `browser/themes/shared/tabbrowser/tab-audio-*-small.svg`. They are MPL-2.0 and 16px context-fill.
- Or an MIT/ISC set with a similar 1.5px-stroke rounded style: **Lucide** (`arrow-left`,
  `arrow-right`, `rotate-cw`, `plus`, `x`, `folder`, `panel-left`, `ellipsis`, `download`, `pin-off`).
  At 16px with `stroke-width: 1.5` this is close to Nucleo's look [inferred].

Icon styling: every icon uses `fill: currentColor` (context-fill). Toolbar icons render at
**70%** `currentColor` (zen-single-components.css:192).

---

## 11. Quick reference: Grove root tokens

```css
/* MPL-2.0 header required if this block is kept verbatim (values from Zen). */
:root {
  color-scheme: light dark;
  --zen-squircle-value: 1.3;
  --sep: 8px;                 /* --zen-element-separation */
  --toolbox-pad: 5px;         /* --zen-toolbox-padding */
  --sidebar-w: 186px;
  --radius-medium: 14px;      /* tabs, tiles, urlbar */
  --radius-button: 8px;       /* toolbar buttons, close button */
  --tab-h: 36px; --tab-gap: 2px; --tab-pad: 8px;
  --essential-h: 46px;
  --indicator-h: 44px;
  --toolbar-h: 36px;          /* sidebar top buttons row */
  --urlbar-row-h: 37px;
  --card-radius: 4px;         /* Linux default; formula §2 */
  --zen-big-shadow: rgba(0,0,0,.24) 0 3px 8px;
  --zen-main-browser-background: light-dark(#e9e9e9, #131313);
  --zen-main-browser-background-toolbar: light-dark(rgb(240,240,244), rgb(23,23,26));
  /* + color tokens from §1.4 */
}
* { corner-shape: superellipse(var(--zen-squircle-value)); }
.no-squircle, .page-card { corner-shape: round; }
```

## 12. Items to verify visually (inferred)

1. Linux tab font size: Zen inherits the GTK font, so pick 13px or match `system-ui` metrics.
2. Exact URL-bar field height (~32–34px within a 37px row).
3. Close-button hover color (Firefox ghost-button hover, ≈10% currentColor).
4. Card radius: 4px comes from an 8px GTK CSD radius. Many users' themes give 8px or more. Consider
   exposing `--card-radius` and defaulting to 8px if 4px looks too sharp next to the 14px tabs.
5. Essentials favicon size (16px upstream default). Zen may render it larger in practice. Check a
   screenshot of Zen's current build.
6. The spring curve replacement for compact reveal.
