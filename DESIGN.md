---
name: Technical Umber
colors:
  surface: '#111415'
  surface-dim: '#111415'
  surface-bright: '#373a3b'
  surface-container-lowest: '#0c0f10'
  surface-container-low: '#191c1d'
  surface-container: '#1d2021'
  surface-container-high: '#282a2b'
  surface-container-highest: '#323536'
  on-surface: '#e1e3e4'
  on-surface-variant: '#d4c4b7'
  inverse-surface: '#e1e3e4'
  inverse-on-surface: '#2e3132'
  outline: '#9c8e82'
  outline-variant: '#50453b'
  surface-tint: '#f0bd8b'
  primary: '#f2be8c'
  on-primary: '#482904'
  primary-container: '#d4a373'
  on-primary-container: '#5b3912'
  inverse-primary: '#7d562d'
  secondary: '#dfc0b2'
  on-secondary: '#3f2c22'
  secondary-container: '#5a443a'
  on-secondary-container: '#d0b2a4'
  tertiary: '#a6caff'
  on-tertiary: '#00315d'
  tertiary-container: '#71afff'
  on-tertiary-container: '#004178'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdcbd'
  primary-fixed-dim: '#f0bd8b'
  on-primary-fixed: '#2c1600'
  on-primary-fixed-variant: '#623f18'
  secondary-fixed: '#fcdccd'
  secondary-fixed-dim: '#dfc0b2'
  on-secondary-fixed: '#28180f'
  on-secondary-fixed-variant: '#574237'
  tertiary-fixed: '#d4e3ff'
  tertiary-fixed-dim: '#a4c9ff'
  on-tertiary-fixed: '#001c39'
  on-tertiary-fixed-variant: '#004883'
  background: '#111415'
  on-background: '#e1e3e4'
  surface-variant: '#323536'
typography:
  headline-lg:
    fontFamily: Geist
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-lg-mobile:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.2'
  headline-md:
    fontFamily: Geist
    fontSize: 20px
    fontWeight: '500'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Hanken Grotesk
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Hanken Grotesk
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1'
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  gutter: 16px
  margin-mobile: 16px
  margin-desktop: 32px
  panel-padding: 24px
  max-width: 1440px
---

## Brand & Style

This design system employs a **Clean Technical** aesthetic with a distinctive high-contrast tonal shift. It targets professional environments that require long-term focus, such as developer tools, financial terminals, or scientific dashboards. The brand personality is precise, authoritative, and sophisticated.

The style blends **Minimalism** with **Modern Enterprise** sensibilities. By utilizing a deep, dark brown "outer" environment and crisp, light "inner" surfaces, the design system creates a clear mental model of "data containers" resting within a stable, grounded void. This approach minimizes peripheral eye strain while maintaining maximum legibility for core content.

## Colors

The palette is driven by a "Deep Earth" foundation. The primary background (`background_base`) is a near-black umber, providing a warm but professional alternative to standard charcoal.

- **Background & Gutters:** Use `#1A110B` for the main canvas. Gutters and "dim" areas use `#241811` to create subtle structural depth.
- **Panels:** All primary content surfaces are `surface_bright` (#FFFFFF), ensuring sharp contrast against the dark background.
- **Accents:** The primary accent is a muted gold/sand (#D4A373) used for technical highlights. A secondary technical blue (#4A90E2) is reserved for interactive states and data visualization.
- **Text:** On light surfaces, use high-contrast dark grays. On dark backgrounds, use the primary accent or a softened off-white.

## Typography

The typography system is engineered for technical clarity. 

- **Geist** is used for headlines to provide a modern, geometric, and "engineered" feel.
- **Hanken Grotesk** serves as the workhorse for body text, offering high readability and a clean, sharp appearance on white surfaces.
- **JetBrains Mono** is utilized for metadata, labels, and small UI details to reinforce the technical/coding heritage of the design system.

Maintain tight tracking on larger headlines and generous leading on body text to facilitate scanability.

## Layout & Spacing

This design system uses a **fixed grid** approach for content panels, floating within a fluid dark environment. 

- **Grid:** A 12-column grid is standard for desktop.
- **Logic:** Content is housed in "Panels" (white surfaces). The space between panels (gutters) exposes the `surface_dim` dark brown. 
- **Desktop:** 32px outer margins with 16px gutters.
- **Mobile:** 16px margins; panels typically stack vertically to occupy full width, with 8px vertical separation to reveal the background.
- **Rhythm:** All spacing (padding, margins) must be multiples of the 4px base unit.

## Elevation & Depth

Hierarchy is established through **Tonal Contrast** rather than traditional shadows.

- **Level 0 (Floor):** The `background_base` (#1A110B). 
- **Level 1 (Gutters/Recesses):** `surface_dim` (#241811) used for navigation bars and sidebars that aren't "active" content.
- **Level 2 (Panels):** `surface_bright` (#FFFFFF). These are the primary focus areas. They do not use shadows; depth is implied by the stark contrast against the dark floor.
- **Outlines:** Use a 1px solid border (`#E9ECEF`) on panels for definition if multiple light panels are adjacent.

## Shapes

The shape language is "Soft Technical." We avoid aggressive 90-degree corners to maintain a contemporary feel, but keep radii small (4px for standard elements) to preserve the "precision instrument" aesthetic.

- **Primary Buttons/Inputs:** 4px (Soft) radius.
- **Panels/Cards:** 8px (Rounded-lg) radius to create a distinct container feel against the dark background.
- **Selection Indicators:** Use sharp vertical bars rather than rounded pills to emphasize the grid-based technical nature.

## Components

- **Panels:** The foundational component. Always white background with dark text. They house all interactive elements.
- **Buttons:** 
  - *Primary:* Solid `secondary_color` (#2C1B12) with white text for maximum impact on white panels.
  - *Secondary:* Outlined with `primary_color` (#D4A373).
- **Input Fields:** Use a subtle `#F1F3F5` background with a 1px bottom border. On focus, the border transitions to the blue accent.
- **Chips/Tags:** Monospaced (JetBrains Mono) text. Use `surface_dim` with the `primary_color` text for a "terminal-style" look within light panels.
- **Lists:** High-density rows with 1px dividers. Use a blue highlight bar on the left edge for the "active" state.
- **Data Grids:** Use `surface_dim` for headers with white monospaced text to create a clear visual break from the white data rows below.