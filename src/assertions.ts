// Assertion switches (-ea, -da, -esa, -dsa) as HotSpot reads them. Names use
// dots; "pkg..." names a package and its subpackages, "..." the unnamed one.

export interface Assertions {
  // in command-line order, so later entries win
  classes: [string, boolean][];
  packages: [string, boolean][];
  user: boolean;
  system: boolean;
}

const FLAG = /^-(ea|enableassertions|da|disableassertions|esa|enablesystemassertions|dsa|disablesystemassertions)(:.*)?$/;

export function isAssertionFlag(arg: string): boolean {
  return FLAG.test(arg);
}

export function parseAssertions(flags: string[]): Assertions {
  const a: Assertions = { classes: [], packages: [], user: false, system: false };
  for (const flag of flags) {
    const m = FLAG.exec(flag);
    if (!m) continue;
    const on = /^(ea|enable|esa)/.test(m[1]);
    if (/^(esa|dsa|enablesystem|disablesystem)/.test(m[1])) a.system = on;
    else if (m[2] === undefined) a.user = on;
    else {
      const name = m[2].slice(1);
      if (name.endsWith("...")) a.packages.push([name.slice(0, -3), on]);
      else a.classes.push([name, on]);
    }
  }
  return a;
}

// JavaAssertions::enabled: the class list, then its packages from the most
// specific out, then the default.
export function assertionsEnabled(a: Assertions, className: string, system: boolean): boolean {
  const last = <T>(list: [string, T][], name: string) => {
    for (let i = list.length - 1; i >= 0; i--) if (list[i][0] === name) return list[i][1];
    return undefined;
  };
  const c = last(a.classes, className);
  if (c !== undefined) return c;
  let len = Math.max(className.lastIndexOf("."), 0);
  do {
    const p = last(a.packages, className.slice(0, len));
    if (p !== undefined) return p;
    len = Math.max(className.lastIndexOf(".", len - 1), 0);
  } while (len > 0);
  return system ? a.system : a.user;
}
