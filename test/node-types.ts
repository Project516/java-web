// Type-only check, run by `pnpm typecheck`: types/node.d.ts matches src/node.ts.

import type * as declared from "../types/node.d.ts";
import type * as real from "../src/node.ts";

type Never<T extends never> = T;

// the declared options are the real ones, less the internal socket backend
export type Extra = Never<Exclude<keyof declared.NodeRunOptions, keyof real.NodeRunOptions>>;
export type Undeclared = Never<Exclude<keyof real.NodeRunOptions, keyof declared.NodeRunOptions | "net">>;
export const options = (o: declared.NodeRunOptions): real.NodeRunOptions => o;

// each declared function accepts what the real one does and returns what it does
export const run: typeof declared.runNode = null! as typeof real.runNode;
export const start: typeof declared.startLibrary = null! as typeof real.startLibrary;
export const lib: typeof declared.libraryOf = null! as typeof real.libraryOf;
