import { Text } from 'ink';

/**
 * The NexusHarness mascot, Nex: one of the small agent robots from the NexusHarness artwork, with a blue helmet, a
 * dark visor with two glowing eyes, and an antenna node like the nodes on the logo's ring. Drawn as pixel art with
 * half-block characters, two pixels per cell (top in the foreground colour, bottom in the background colour), so it
 * keeps its shape in any terminal with true colour. 18 × 14 pixels = 18 columns × 7 rows.
 */
const PIXELS = [
  '........NN........',
  '........aa........',
  '.....hhhhhhhh.....',
  '...hhHHHHHHHHhh...',
  '..hHHVVVVVVVVHHh..',
  'nHHVVWeVVVVWeVVHHn',
  'nHHVVEEVVVVEEVVHHn',
  '.HHHVVVVVVVVVVHHH.',
  '..HHHHHHHHHHHHHH..',
  '...dddddddddddd...',
  '.......cccc.......',
  '....bbbbbbbbbb....',
  '...bbbbbLLbbbbb...',
  '...BBBBBBBBBBBB...',
];

const PALETTE: Record<string, string | undefined> = {
  N: '#a8f3ff', // antenna node (glowing)
  a: '#2f6bff', // antenna
  h: '#86dcff', // helmet highlight
  H: '#2f7bff', // helmet
  d: '#1c4cc0', // helmet shade
  V: '#071226', // visor
  W: '#ffffff', // eye glint
  e: '#6ff3ff', // eyes
  E: '#2bb7ff', // eyes, lower half
  n: '#5cc8ff', // ear nodes
  c: '#14306e', // neck
  b: '#2463e8', // body
  L: '#a8f3ff', // chest light
  B: '#163c9e', // body shade
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
