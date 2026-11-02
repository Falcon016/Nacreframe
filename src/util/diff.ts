export interface DiffStats {
  added: number;
  removed: number;
}

/** Unified-style line diff (LCS). Falls back to a coarse summary for very large inputs. */
export function unifiedDiff(
  oldText: string,
  newText: string,
  context = 3,
  label = '',
): { text: string } & DiffStats {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length * b.length > 4_000_000) {
    return {
      text: `(diff too large to display: ${a.length} → ${b.length} lines)`,
      added: b.length,
      removed: a.length,
    };
  }
  // Trim common prefix/suffix to shrink the DP table.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf])
    suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const n = am.length;
  const m = bm.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  type Op = { t: ' ' | '-' | '+'; s: string };
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', s: a[i]! });
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (am[i] === bm[j]) {
      ops.push({ t: ' ', s: am[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ t: '-', s: am[i++]! });
    else ops.push({ t: '+', s: bm[j++]! });
  }
  while (i < n) ops.push({ t: '-', s: am[i++]! });
  while (j < m) ops.push({ t: '+', s: bm[j++]! });
  for (let k = a.length - suf; k < a.length; k++) ops.push({ t: ' ', s: a[k]! });

  const added = ops.filter((o) => o.t === '+').length;
  const removed = ops.filter((o) => o.t === '-').length;

  // Emit hunks with context.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.t !== ' ')
      for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++)
        keep[k] = true;
  });
  const out: string[] = label ? [label] : [];
  let oldLine = 1;
  let newLine = 1;
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k]!.t !== '+') oldLine++;
      if (ops[k]!.t !== '-') newLine++;
      k++;
      continue;
    }
    const start = k;
    const hunkOld = oldLine;
    const hunkNew = newLine;
    const lines: string[] = [];
    let oc = 0;
    let nc = 0;
    while (k < ops.length && keep[k]) {
      const o = ops[k]!;
      lines.push(o.t + o.s);
      if (o.t !== '+') {
        oc++;
        oldLine++;
      }
      if (o.t !== '-') {
        nc++;
        newLine++;
      }
      k++;
    }
    void start;
    out.push(`@@ -${hunkOld},${oc} +${hunkNew},${nc} @@`, ...lines);
  }
  return { text: out.join('\n'), added, removed };
}
