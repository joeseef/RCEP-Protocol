# RL4 Snapshot Design System (Frozen)

This repository follows a single visual language across:
- Chrome extension popup UI
- GitHub diagrams (SVG)
- Documentation styling

The goal is a **research‑grade** and **premium tool** feel: minimal, high-contrast, and consistent.

---

## 1) Brand palette

### Core colors
- **Brand Pink**: `#F4E9E8`
- **Brand Ink**: `#121012`
- **Background Primary**: `#05050A`
- **Background Secondary**: `#090613`

### Supporting colors (dark UI)
- **Surface (glass)**: `rgba(255,255,255,0.03)`
- **Border**: `rgba(244,233,232,0.12)` (brand-tinted)
- **Text Primary**: `rgba(255,255,255,0.96)`
- **Text Secondary**: `rgba(255,255,255,0.70)`
- **Text Muted**: `rgba(255,255,255,0.40)`

### CTA gradient (logo-aligned)
Use rose tones instead of neon purple:

```css
--cta-gradient: linear-gradient(135deg, #F4E9E8, #E7CDCB, #D9B1AE);
```

---

## 2) Typography
- Prefer system UI stack with Inter/Geist when available.
- Titles: bold, clean, no excessive letter spacing.
- Code: monospaced for hashes, IDs, protocol fields.

---

## 3) Spacing (8‑pt grid)
Use these steps consistently:
- 4 / 8 / 12 / 16 / 20 / 24 px

---

## 4) Components
### Logo badge (dark background)
- Badge background must be **Brand Pink** `#F4E9E8`
- Logo must be black “ink” on top
- Rounded container + subtle shadow

### Cards / boxes
- Glass surface background
- Subtle brand-tinted border
- Generous padding (16px)

---

## 5) Diagram style (SVG)
Diagrams must:
- use **Background Primary** for canvas,
- use **brand-tinted borders** and arrows,
- avoid neon purple/blue accents.


