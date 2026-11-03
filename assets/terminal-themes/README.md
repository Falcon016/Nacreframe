# Nacre terminal colour schemes

Nacreframe's interface uses true-colour accents and leaves the background to your terminal. These schemes match it
(near-black `#08070b`, pearl text `#ebe7f2`, violet `#9d84ff`).

| Terminal         | File                          | How                                                                                     |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| Windows Terminal | `nacre.windows-terminal.json` | Settings → Open JSON file → paste the object into `"schemes"`, then set it on a profile |
| Ghostty          | `nacre.ghostty`               | Save as `~/.config/ghostty/themes/nacre`, set `theme = nacre`                           |
| Alacritty        | `nacre.alacritty.toml`        | Import it from `alacritty.toml`                                                         |

For typography, a monospace with good box-drawing glyphs works best (JetBrains Mono, Cascadia Code, Berkeley Mono,
SF Mono). The wordmark in `assets/banner.svg` uses IBM Plex Sans, falling back to the system sans-serif.
