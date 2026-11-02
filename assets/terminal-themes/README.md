# Nacre terminal colour schemes

Nacreframe's interface uses true-colour accents and leaves the background to your terminal. These schemes match it
(deep ink `#121118`, warm pearl text `#e9e4da`).

| Terminal         | File                          | How                                                                                     |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| Windows Terminal | `nacre.windows-terminal.json` | Settings → Open JSON file → paste the object into `"schemes"`, then set it on a profile |
| Ghostty          | `nacre.ghostty`               | Save as `~/.config/ghostty/themes/nacre`, set `theme = nacre`                           |
| Alacritty        | `nacre.alacritty.toml`        | Import it from `alacritty.toml`                                                         |

For typography, a monospace with good box-drawing glyphs works best (JetBrains Mono, Cascadia Code, Berkeley Mono,
SF Mono). The serif wordmark in `assets/banner.svg` uses Newsreader, falling back to Georgia.
