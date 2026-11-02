/** Convert a glob (`*`, `**`, `?`, `{a,b}`) to a RegExp. */
export function globToRegExp(glob: string, flags = ''): RegExp {
  return new RegExp(`^${globBody(glob)}$`, flags);
}

function globBody(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        const alts = glob
          .slice(i + 1, end)
          .split(',')
          .map((a) => globBody(a));
        re += `(?:${alts.join('|')})`;
        i = end;
      }
    } else if ('\\^$+.()|[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return re;
}

/** Match a glob against a value. Case-insensitive on Windows; backslashes normalised to `/`. */
export function globMatch(glob: string, value: string): boolean {
  const flags = process.platform === 'win32' ? 'i' : '';
  return globToRegExp(glob, flags).test(value.replaceAll('\\', '/'));
}
