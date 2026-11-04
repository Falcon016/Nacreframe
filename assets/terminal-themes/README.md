# Nexus terminal colour schemes

NexusHarness's interface uses true-colour accents and leaves the background to your terminal. These schemes match it
(near-black `#04060a`, cool white text `#e6edf7`, electric blue `#5b8cff` and a cyan accent `#5cc8ff`).

| Terminal         | File                          | How                                                                                     |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| Windows Terminal | `nexus.windows-terminal.json` | Settings → Open JSON file → paste the object into `"schemes"`, then set it on a profile |
| Ghostty          | `nexus.ghostty`               | Save as `~/.config/ghostty/themes/nexus`, set `theme = nexus`                           |
| Alacritty        | `nexus.alacritty.toml`        | Import it from `alacritty.toml`                                                         |

For typography, a monospace with good box-drawing glyphs works best (JetBrains Mono, Cascadia Code, Berkeley Mono,
SF Mono).
