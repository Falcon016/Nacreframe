import { Text } from 'ink';

/**
 * The Nacreframe mascot: a pearl peeking out of its oyster shell. Drawn as pixel art with half-block
 * characters, two pixels per cell (top in the foreground colour, bottom in the background colour), so it
 * keeps its shape in any terminal with true colour. 18 × 14 pixels = 18 columns × 7 rows.
 */
const PIXELS = [
  '....hhhhhhhhhh....',
  '..hhssssssssssh...',
  '.hsSsSsSsSsSsSsh..',
  '.sSSSSSSSSSSSSSs..',
  '..ss.PPPPPPPP.ss..',
  '....PPPPPPPPPPp...',
  '...PPPEEPPPEEPPp..',
  '...PPPEWPPPEWPPp..',
  '...PrPPPPPPPPrPp..',
  '....PPPPEEPPPPp...',
  '.sSSSPPPPPPPPSSSs.',
  '.sSSSSSSSSSSSSSSs.',
  '..ssssssssssssss..',
  '..................',
];

const PALETTE: Record<string, string | undefined> = {
  h: '#a792ff', // shell rim
  s: '#7a60e6', // shell
  S: '#4a34a0', // shell ridges
  P: '#ece8f3', // pearl
  p: '#c4b6fa', // pearl shade
  E: '#100c18', // eyes and mouth
  W: '#ffffff', // eye glint
  r: '#e98bd0', // blush
};

export const MASCOT_WIDTH = PIXELS[0]!.length;
export const MASCOT_HEIGHT = PIXELS.length / 2;

interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
}

function cells(top: string, bottom: string): Cell[] {
  return [...top].map((t, i) => {
    const a = PALETTE[t];
    const b = PALETTE[bottom[i]!];
    if (!a && !b) return { ch: ' ' };
    if (a && !b) return { ch: '▀', fg: a };
    if (!a && b) return { ch: '▄', fg: b };
    return a === b ? { ch: '█', fg: a } : { ch: '▀', fg: a, bg: b };
  });
}

export function Mascot() {
  const rows: Cell[][] = [];
  for (let y = 0; y < PIXELS.length; y += 2) rows.push(cells(PIXELS[y]!, PIXELS[y + 1]!));
  return (
    <>
      {rows.map((row, y) => {
        // Merge runs of identical cells into one span to keep the output small.
        const runs: Cell[] = [];
        for (const c of row) {
          const last = runs.at(-1);
          if (last && last.fg === c.fg && last.bg === c.bg && last.ch[0] === c.ch) last.ch += c.ch;
          else runs.push({ ...c });
        }
        return (
          <Text key={y}>
            {runs.map((r, i) => (
              <Text key={i} {...(r.fg ? { color: r.fg } : {})} {...(r.bg ? { backgroundColor: r.bg } : {})}>
                {r.ch}
              </Text>
            ))}
          </Text>
        );
      })}
    </>
  );
}
