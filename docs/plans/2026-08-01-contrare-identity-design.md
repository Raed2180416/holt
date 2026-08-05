# Contrare Research — Unified Identity & Design System Spec

**Date:** 2026-08-01
**Status:** Draft — pending user approval
**Scope:** Four websites (Contrare Research, Holt, Medes, Portfolio) + shared design system

---

## 1. Brand architecture

```
     [ CONTRARE RESEARCH ]  ← Umbrella research lab
              │
    ┌─────────┴──────────┐
    ▼                    ▼
  [ ARC ]              [ HOLT ]
  AI Research          Agent safety
  Cohort               guardrail
    │
    ├── [ CLIDE ]  — CLI + IDE, the interface
    └── [ MEDES ]  — Interactive textbook, the reader
```

**The Archimedes wordplay:** ARC + MEDES = ARCHIMEDES. "Give me a lever long enough and a fulcrum on which to place it, and I shall move the world." The lever is maximal leverage over knowledge and computation.

**Naming:** The parent site currently says "Contrare ARC" everywhere. This is wrong. The product is **ARC CLIDE** — ARC is the engine, CLIDE is the interface. The parent site is **Contrare Research**. All references to "Contrare ARC" in the existing site become "ARC CLIDE" or "Contrare Research" depending on context.

**Holt positioning:** Holt is a **Contrare Research project**, not part of ARC. Holt is a sibling to ARC under the Contrare Research umbrella. The Holt site must say this explicitly.

**Medes positioning:** Medes is an **ARC project** — it sits under ARC alongside CLIDE. The Medes site is branded "ARC Medes — a Contrare Research project."

**Contact:** All sites use `thisisraed@outlook.com`. The current `contrare.research@outlook.com` is replaced everywhere.

---

## 2. Logo & glyph specification

### Current decision: placeholders + flipped Contrare mark

Logos are **placeholders** for now. The design system, sites, and everything else gets built first. Logos get refined later.

**Contrare Research:** Keep the existing ∅-style mark (circle + diagonal line) but **flip the diagonal**. Grok/xAI's diagonal goes top-right to bottom-left. Ours goes **top-left to bottom-right** — the inverse. Same visual language, opposite direction. This is the only logo decision made now; everything else is a placeholder.

```svg
<!-- Existing: bottom-left to top-right (matches Grok) -->
<line x1="7.9" y1="24.1" x2="24.1" y2="7.9" />

<!-- New: top-left to bottom-right (the inverse) -->
<line x1="7.9" y1="7.9" x2="24.1" y2="24.1" />
```

**Other products:** Placeholder marks (simple geometric forms or text-only wordmarks) until the logo system is finalized. Don't block site building on logo design.

### Favicon assignments (placeholder)

| Site | Favicon | Accent |
|---|---|---|
| Contrare Research | ∅ with flipped diagonal (top-left → bottom-right) | Violet |
| ARC CLIDE | Placeholder (text "ARC" or simple geometric) | Violet |
| Medes | Placeholder (stacked layers from v3 prototype) | Warm amber |
| Holt | Placeholder (lock shackle from v3 prototype) | Amber-gold |
| Portfolio | Personal "RS" mark (existing) | Cyan/orange |

### SVG templates

See `site/logo-prototype.html` for rendered examples of all five logos plus the synthesis mark and size tests.

---

## 3. Design token system

### Typography

```css
--font-display:  "Space Grotesk", system-ui, sans-serif;     /* Headlines, wordmarks */
--font-body:     "Inter", system-ui, -apple-system, sans-serif; /* Body copy, UI */
--font-mono:     "JetBrains Mono", ui-monospace, monospace;   /* Code, metadata, numbers */
--font-book:     "Iowan Old Style", Palatino, Georgia, serif; /* MEDES only — reading text */
```

**Rules (from interior.dev):**
- Headings are **medium weight (500)**, never bold. Negative tracking does the work.
- Mono is for metadata, numbers, code, and keycaps only — never as a default voice.
- `leading-none` is banned on anything containing a word.
- Uppercase is always `tracking-[0.06em]` or `[0.08em]`.
- Anything showing a number gets `tabular-nums` / `font-variant-numeric: tabular-nums`.

### Color — shared neutral ramp

Built on interior.dev's three-material model (bezel / panel / well) with OKLCH:

```css
/* Dark mode (default for Contrare, ARC CLIDE, Holt) */
--bezel:        oklch(14% 0.006 250);   /* page background — dark warm near-black */
--panel:        oklch(20% 0.008 250);   /* lifted card */
--well:         oklch(25% 0.010 250);   /* recessed slot: inputs, code, previews */

--ink:          oklch(88% 0.004 250);   /* primary text */
--ink-2:        oklch(68% 0.008 250);   /* body copy */
--ink-3:        oklch(52% 0.006 250);   /* metadata, labels, disabled */

--hairline:        oklch(50% 0.006 250 / 17%);   /* dividers */
--hairline-strong: oklch(50% 0.006 250 / 28%);   /* hover borders, scrollbar */

/* Light mode (default for Medes reading, portfolio) */
--bezel-light:  oklch(96% 0.006 85);    /* warm near-white */
--panel-light:  oklch(99% 0.004 85);    /* white card */
--well-light:   oklch(94% 0.008 85);    /* recessed */

--ink-light:    oklch(18% 0.006 85);    /* primary text */
--ink-2-light:  oklch(42% 0.008 85);    /* body copy */
--ink-3-light:  oklch(58% 0.006 85);    /* metadata */

--hairline-light:        oklch(18% 0.006 85 / 17%);
--hairline-strong-light: oklch(18% 0.006 85 / 28%);
```

### Color — product accents

Each product gets one accent. The accent marks **interaction and state** — it is never decoration. The one place it appears without an interaction is the wordmark.

```css
--accent-contrare:  oklch(72% 0.14 280);   /* violet — the institute, ARC */
--accent-clide:     oklch(72% 0.14 250);   /* blue — the tool */
--accent-medes:     oklch(68% 0.10 55);    /* warm amber — the reader */
--accent-holt:      oklch(75% 0.13 50);    /* amber-gold — the guardrail */
```

**CLIDE theme system note:** CLIDE's product has 12 switchable themes (Tokyo Night, Rose Pine, Catppuccin, etc.). These are a *product feature* showcased on the marketing site via swatches. The marketing site's **default identity** is blue (`--accent-clide`). The theme swatch demo defaults to Tokyo Night (the product's most popular theme) to showcase capability. When a user clicks a swatch, the demo terminal's **accent color and syntax highlighting** change to that theme — but the **page structure** (nav, cards, section backgrounds, body text) remains on the Contrare neutral ramp. This separation means: the site always reads as Contrare structurally, while the CLIDE demo terminal proves the product's theme engine works.

### Color — semantic

```css
--ok:     oklch(65% 0.16 145);   /* safe, success, disposable */
--hold:   oklch(70% 0.15 65);    /* warning, at risk, holding */
--fault:  oklch(65% 0.18 25);    /* error, danger, holds unique work */
```

### Spacing

```css
--space-1:  4px;
--space-2:  8px;
--space-3:  12px;
--space-4:  16px;
--space-5:  24px;
--space-6:  34px;
--space-7:  52px;
--space-8:  72px;
```

### Radii (nesting rule: outer = inner + padding)

```css
--r-page:    20px;   /* page panel */
--r-frame:   16px;   /* preview/code frame */
--r-card:    14px;   /* card, section */
--r-row:     11px;   /* row card, popover */
--r-field:   10px;   /* input, button */
--r-list:     9px;   /* list row */
--r-nested:   8px;   /* nested row, tab */
--r-icon:     7px;   /* icon button */
--r-chip:     6px;   /* chip, small action */
--r-cell:     5px;   /* cell, kbd */
--r-track:    4px;   /* progress track */
--r-fill:     2px;   /* fill, tick */
```

### Material shadows

```css
/* Light mode — ink shadows (rgba(28,25,23,·), never rgba(0,0,0,·)) */
.mat-panel  { box-shadow: 0 1px 2px rgba(28,25,23,0.06), 0 4px 10px -8px rgba(28,25,23,0.45); }
.mat-float  { box-shadow: 0 28px 56px -24px rgba(24,22,20,0.45); }   /* modal, detail */
.mat-pop    { box-shadow: 0 18px 40px -24px rgba(28,25,23,0.5); }    /* popover */
.mat-well   { box-shadow: inset 0 1px 2px rgba(28,25,23,0.07); }     /* recessed */
.mat-cap    { box-shadow: inset 0 1.5px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(28,25,23,0.06); }

/* Dark mode — black shadows + top highlight */
.mat-panel-dark  { box-shadow: 0 1px 6px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04); }
.mat-float-dark  { box-shadow: 0 28px 56px -24px rgba(0,0,0,0.6); }
.mat-pop-dark    { box-shadow: 0 18px 40px -24px rgba(0,0,0,0.55); }
.mat-well-dark   { box-shadow: inset 0 1px 2px rgba(0,0,0,0.45); }
.mat-cap-dark    { box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), inset 0 -1px 0 rgba(0,0,0,0.3); }
```

**Rule:** A plain `border` never carries elevation. Use hairlines for compartment division, material shadows for depth.

### Motion

```js
const EASE  = [0.23, 1, 0.32, 1];  // arriving — decelerates into place
const LEAVE = [0.4, 0, 1, 1];      // leaving — accelerates out

enter:     0.22s  { opacity: 0, scale: 0.97, y: 10, filter: "blur(6px)" }
exit:      0.18s  { opacity: 0, scale: 0.98, y: 6,  filter: "blur(3px)" }
list:      0.34s  y + scale, transformOrigin pinned to edge of origin
disclose:  0.28s  height 0 → auto, opacity trailing at 0.18s
select:    0.20s  content slides 3px right
press:     0.12s  translateY(1px)
```

**Rules:**
- Scale never starts at 0. Minimum 0.9.
- `transformOrigin` always pinned to the edge the thing came from.
- Blur on enter (6px), less on exit (3px). Asmetry = "settles" vs "appears."
- Departures are always shorter than arrivals (0.11–0.18s vs 0.20–0.28s).
- No infinite loops except: marquee, streaming caret (hard square wave, never fade).
- `prefers-reduced-motion`: information still arrives, trip is skipped. Never hide the element.

### Banned (adopted as law across all sites)

| Banned | Instead |
|---|---|
| `rounded-full`, pills, circular avatars | 5/6/9/11/14/20px radii |
| `animate-pulse`, any idle loop | Discrete cells, event-driven motion |
| Grid/dot-grid backgrounds | Material depth (bezel/panel/well) |
| Decorative gradients, glow, aurora | One accent, where it means something |
| Borders standing in for depth | `.mat-*` shadows |
| Drop shadows to "add polish" | Material already has the shadow |
| Uppercase mono as default voice | Mono for metadata/numbers only |

**Standing exemptions** (each needs a one-sentence defense):
- Spinner: unknown duration, constant speed, one arc
- Marquee: the loop IS the component
- Caret blink: hard square wave (terminal's own shape)

---

## 4. UI & component guidelines

### Layout grammar (shared)

- **Page shell:** Panel floating on bezel, generous gutter (`padding: clamp(12px, 3vw, 20px)`, `border-radius: 20px`)
- **Max content width:** 1240px (Contrare, Holt) or 700px (Medes reading mode)
- **Section rhythm:** `padding: clamp(64px, 9vw, 116px) clamp(16px, 4vw, 44px)` between major sections
- **Card grid:** `repeat(auto-fit, minmax(300px, 1fr))` with `gap: clamp(24px, 4vw, 52px)`
- **Sticky nav:** `backdrop-filter: blur(14px)`, bezel at 72% opacity, hairline bottom border

### Component specs

**Status pills (all sites):**
- `font-mono`, 11px, `letter-spacing: 0.08em`, uppercase
- Filled, not outlined. `border-radius: 6px`, `padding: 4px 10px`
- States: `[RUNNING]` = accent, `[HOLDING]` = hold, `[SAFE]` = ok, `[AT RISK]` = fault, `[DISPOSABLE]` = ink-3

**Code blocks (Contrare, CLIDE, Holt):**
- Well material (recessed). `--well` bg, `border-radius: 16px`
- JetBrains Mono, 13px, `line-height: 1.5`
- Title bar: panel bg, 11.5px mono, status dot + filename
- Holt: no external syntax highlighter (self-contained constraint) — CSS class-based highlighting

**Recursive tooltip stacks (Medes):**
- Each layer is a panel that lifts from the well
- `transformOrigin` pinned to the term pulled
- Enter: 0.22s EASE, blur(6px) → 0
- Depth indicator: discrete cells on left margin, one per layer
- Book serif for layer content, system-ui for chrome

**Diff locks (Holt):**
- Tree-view showing worktree relationships
- Status colors: ok (safe), hold (at risk), fault (holds unique work)
- `hold-to-confirm` pattern for delete actions — the physical guardrail made visual
- Lock icon from the Holt glyph when a worktree is locked

**Terminal panels (CLIDE):**
- 4-zone shell: chats+folders | chat timeline | panel (Notes/Files/Web/View/Graph) | terminal
- Each zone is a well inside the panel
- Status bar: model, VRAM, throughput, network — mono, 11.5px
- Blinking caret: hard square wave, never fade

**Theme swatches (CLIDE feature showcase):**
- Row of 12 small swatches, each showing the theme's accent color
- Clicking a swatch switches the demo terminal's theme live
- Default: Tokyo Night (or the new Contrare default)
- This is a product feature demo, not the site's identity

---

## 5. Copywriting & personality

### Voice

**Orthogonal & contrarian.** Proudly built against the grain. Short, declarative, a little dry. Never marketing buzz. Never dumbing down. Every technical explanation is concise enough that a non-technical reader gets the idea, but precise enough that a technical reader doesn't feel patronized.

### Tone by context

| Context | Tone |
|---|---|
| Marketing headline | Bold, contrarian, short |
| Technical explanation | Plain English, precise terms, one idea per sentence |
| Error/empty state | Calm, factual, actionable |
| Status indicator | Terse. `[RUNNING]` not "Currently processing..." |
| Footer/legal | Direct, no hedging |

### Taglines

| Entity | Tagline |
|---|---|
| **Contrare Research** | "Orthogonal by design." |
| **ARC CLIDE** | "The harness, not the horsepower." |
| **Medes** | "Never leave the page." |
| **Holt** | "Never lose work your agents wrote." |

### Micro-copy examples

- **Empty (Medes):** "Your shelf is empty. Drop a PDF or EPUB to begin."
- **Status (Holt):** "5 worktrees hold work existing only as uncommitted changes."
- **Error (CLIDE):** "The model didn't respond in time. The harness is retrying with a tighter context."
- **Confirm (Holt):** "This worktree holds the only copy of a security fix. Delete anyway? Hold to confirm."

### Contact

All sites: `thisisraed@outlook.com`

---

## 6. Site architecture

### Contrare Research (parent site) — restructured

**File:** `/home/raed/.agentic-os/apps/website/Contrare.dc.html`
**Stack:** Vanilla HTML/CSS/JS (self-contained, Google Fonts allowed)
**Changes:**

1. **Rename:** "Contrare ARC" → "Contrare Research" (parent brand) and "ARC CLIDE" (product). All references updated.
2. **Kill the ∅ mark:** Replace with lever/fulcrum logo family.
3. **Restructure from single-product to ecosystem:**
   - Hero: "Orthogonal by design." — Contrare Research as an institute
   - Ecosystem map section (new): The Archimedes lever diagram. Three product cards.
   - ARC CLIDE section (condensed from current site)
   - Medes section (new)
   - Holt section (new)
   - Footer: "Built with Holt. Powered by ARC."
4. **Contact:** `thisisraed@outlook.com` everywhere
5. **Apply shared tokens:** Fonts (Space Grotesk + Inter + JetBrains Mono), material system, radii, motion
6. **Keep theme swatch showcase** as a CLIDE feature section

### Holt site — modified

**File:** `/home/raed/grove/site/index.html`
**Stack:** Vanilla HTML/CSS/JS (self-contained — no external CDN, offline-first constraint)
**Changes:**

1. **Rebrand as Contrare Research project:**
   - Nav or hero subhead: "A Contrare Research project"
   - Footer: "Contrare Research · Holt"
   - Remove the trademark marker (we're not trademarking yet)
2. **Remove trademark marker:** The marker is removed from the footer and README. Holt is not trademarked yet.
   - Holt protects the worktrees that build Holt
   - The development workflow story
3. **Apply shared tokens:** Switch from system fonts to Space Grotesk + Inter + JetBrains Mono (self-hosted — see font self-hosting section below)
4. **New logo:** Lever + lock glyph replacing the 🌳 tree emoji
5. **Keep amber-gold accent** (now `--accent-holt`)
6. **Contact:** `thisisraed@outlook.com`
7. **Material system:** Apply bezel/panel/well shadows

**Font constraint solution:** Self-host the fonts as `.woff2` files in the site directory, or use the system font stack with Space Grotesk as the preferred family (graceful degradation). The self-contained constraint means no CDN — but self-hosted files are fine.

### Medes site — new

**Location:** TBD (likely `/home/raed/Projects/idea/interactive-textbook/site/` or a new directory)
**Stack:** React + interior.dev components + Motion (no self-contained constraint — this is a showcase)
**Content:**

1. **Hero:** "Never leave the page." — animated recursive tooltip demo
2. **Feature sections:** Using the 30+ existing screenshots from `design/img/`
3. **Page tones showcase:** Interactive toggle (paper/sepia/grey/night)
4. **Widget gallery:** Gradient descent, vector fields, etc. as live demos or animations
5. **Privacy architecture section**
6. **Status:** "In active development"
7. **Branding:** "ARC Medes — a Contrare Research project"
8. **Contact:** `thisisraed@outlook.com`
9. **Accent:** Warm amber (`--accent-medes`)
10. **Interior.dev components used:** TextReveal (hero), Tabs (feature sections), WizardSteps (learning progression), LiveActivity (AI processing state), TooltipGroup (feature tooltips), SkeletonSwap (image loading)

### Portfolio — rebuilt from scratch

**Location:** `/home/raed/Projects/portfolio/`
**Stack:** Vanilla HTML/CSS/JS (simple, deployable, no build step)
**Changes:**

1. **Rebuild from scratch** — the current bundle is a Claude.ai artifact with no source
2. **Keep personal aesthetic:** Dark, Chakra Petch, cyan/orange — this is the *personal* identity, separate from the Contrare system
3. **Add project cards** for:
   - Contrare Research (parent, with ecosystem diagram)
   - ARC CLIDE (violet accent hint)
   - Medes (warm amber accent hint)
   - Holt (amber-gold accent hint)
   - Other existing projects (AirMentor, GeoWake, blink-n-drift, etc.)
4. **"Part of something greater" visual:** Small ecosystem map connecting the Contrare project cards
5. **Each project card** uses the product's accent color as a subtle border or icon tint — enough to hint at the shared identity without making the portfolio look like a Contrare site
6. **Contact:** `thisisraed@outlook.com`

---

## 7. Tech stack decisions

| Site | Stack | Constraint | Fonts |
|---|---|---|---|
| Contrare Research | Vanilla HTML/CSS/JS | Google Fonts OK | Space Grotesk + Inter + JetBrains Mono (CDN) |
| Holt | Vanilla HTML/CSS/JS | Self-contained (no CDN) | Space Grotesk + Inter + JetBrains Mono (self-hosted .woff2) |
| Medes | React + interior.dev + Motion | No constraint | Space Grotesk + Inter + JetBrains Mono + Iowan Old Style (for book context) |
| Portfolio | Vanilla HTML/CSS/JS | Simple deployable | Chakra Petch + JetBrains Mono (personal aesthetic — **exempt** from shared system, see below) |

### Portfolio font exemption

The portfolio uses Chakra Petch + JetBrains Mono instead of the shared Space Grotesk + Inter system. **Defense (per the banned-section exemption rule):** the portfolio is a *personal* site, not a Contrare product site. Its job is to show Raed's individual identity, with the Contrare projects appearing as *cards within it* — each card hinting at its product accent. Making the portfolio look like a Contrare site would invert the relationship (the person becomes the product). The portfolio is exempt from the shared font system; the project cards within it use the product accent colors as subtle hints.

### Font self-hosting (Holt)

Holt's self-contained constraint means no external CDN. The three shared fonts are self-hosted as `.woff2` files:

- **Space Grotesk:** SIL Open Font License 1.1 — self-hosting permitted
- **Inter:** SIL Open Font License 1.1 — self-hosting permitted
- **JetBrains Mono:** SIL Open Font License 1.1 — self-hosting permitted

**Subsetting:** Use `pyftsubset` (from fonttools) to subset to Latin + Latin-Extended character sets. This reduces each font from ~300KB to ~30-50KB. Weights needed: Space Grotesk 500/600, Inter 400/500, JetBrains Mono 400/500.

**Fallback:** If self-hosting proves impractical for any reason, fall back to system fonts with the preferred family listed first: `font-family: 'Space Grotesk', system-ui, sans-serif`. The design still works — the geometry (spacing, radii, material depth) carries the identity, not the typeface alone.

**Interior.dev usage:**
- **What it is:** interior.dev is a copy-paste React component library (github.com/ddoemonn/interior). No npm package — each component is a single .tsx file you copy into your project. The only dependency is `motion` (motion.dev). License: MIT.
- **Medes site:** Full interior.dev components (React + Motion). Components are copied into the project's `components/` directory. Used components: TextReveal (hero), Tabs (feature sections), WizardSteps (learning progression), LiveActivity (AI processing state), TooltipGroup (feature tooltips), SkeletonSwap (image loading), ScrollSpy (section navigation), ReadingProgress (scroll indicator).
- **Contrare site:** Vanilla equivalents of interior.dev patterns (the design language — material depth, discrete cells, motion curves — but implemented in plain CSS/JS, not React components). The site is a single self-contained HTML file.
- **Holt site:** Vanilla equivalents (self-contained constraint prevents React/Motion dependency).
- **Portfolio:** Vanilla, personal aesthetic.

---

## 8. Build order

1. **Contrare Research** (parent-first) — establishes the design system, logo family, and ecosystem structure. Product sections (ARC CLIDE, Medes, Holt) use placeholder links to the product sites that will be built next. The parent site is the design system reference — once it's right, the others inherit.
2. **Holt** — applies the system to an existing deployed site. Validates the design system works on a real site with real constraints (self-contained, no CDN). Quick win.
3. **Medes** — greenfield site using the full system + interior.dev React components. Most design-intensive (showcase visuals, interactive demos).
4. **Portfolio** — rebuild with project cards and identity hints. Personal aesthetic, Contrare project cards within it.

**Circular dependency note:** The Contrare Research parent site links to product sites that don't exist yet. This is fine — the links point to where the sites *will* be (e.g., `medes.contrare.research` or a GitHub Pages URL). The parent site's product sections have their own content (not just links), so the page is complete on its own. As each product site is built, the parent site's links start resolving.

---

## 9. What changes from current state

### Contrare site (`Contrare.dc.html`)
- "Contrare ARC" → "Contrare Research" / "ARC CLIDE"
- ∅ logo diagonal flipped: top-right→bottom-left (Grok direction) → top-left→bottom-right (our direction)
- Single-product page → ecosystem page with ARC CLIDE + Medes + Holt sections
- `contrare.research@outlook.com` → `thisisraed@outlook.com`
- System fonts for body → Inter
- Tokyo Night as only default → shared neutral ramp + violet accent as default, theme swatches as feature
- Terminal text "arc · clide" stays (already correct)

### Holt site (`site/index.html`)
- 🌳 tree emoji logo → lever + lock glyph
- System fonts → Space Grotesk + Inter + JetBrains Mono (self-hosted)
- "Contrare · Holt" → "Contrare Research · Holt"
- No dogfooding section → "Used extensively in its own development" section
- No "Contrare Research project" framing → explicit framing in nav/hero
- Contact (if any) → `thisisraed@outlook.com`

### Medes
- No website → new showcase site
- No branding → "ARC Medes — a Contrare Research project"

### Portfolio
- Bundled artifact with no source → clean rebuild
- No project segments → cards for all Contrare projects + existing projects
- No ecosystem visual → small Archimedes diagram connecting Contrare projects
