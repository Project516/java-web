// Prints the change list of a release as Markdown: the squash-merged pull
// requests since the last tag, grouped by Conventional Commit type, up to the
// next tag, or before it is made, its version bump commit. Without a next tag,
// up to HEAD. Write a few sentences for users above it.
//
//   node scripts/release-notes.ts [<since-tag> [<next-tag>]]   (since: the newest tag before HEAD)

import { execFileSync } from "node:child_process";

const REPO = "https://github.com/Project516/java-web";
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

const since = process.argv[2] ?? git("describe", "--tags", "--abbrev=0");
const next = process.argv[3];
function endOf(next: string): string {
  if (git("tag", "--list", next) === next) return next;
  const title = `chore: release ${next.replace(/^v/, "")}`;
  const bump = git("log", "--first-parent", "--format=%H %s", `${since}..HEAD`).split("\n").find((l) => {
    const subject = l.slice(l.indexOf(" ") + 1);
    return subject === title || (subject.startsWith(title + " (#") && /^ \(#\d+\)$/.test(subject.slice(title.length)));
  });
  if (!bump) {
    console.error(`no tag ${next} and no "chore: release" commit for it since ${since}`);
    process.exit(1);
  }
  return bump.slice(0, bump.indexOf(" "));
}
const end = next ? endOf(next) : git("rev-parse", "HEAD");
const titles = git("log", "--first-parent", "--format=%s", `${since}..${end}`).split("\n").filter(Boolean);

interface Entry { type?: string; scope?: string; breaking?: boolean; summary: string; pr?: string }
const sections: [string, (e: Entry) => boolean][] = [
  ["Breaking changes", (e) => !!e.breaking],
  ["Features", (e) => e.type === "feat"],
  ["Performance", (e) => e.type === "perf"],
  ["Fixes", (e) => e.type === "fix"],
  ["Dependencies", (e) => e.scope === "deps"],
  ["Build and CI", (e) => e.type === "build" || e.type === "ci"],
  ["Documentation", (e) => e.type === "docs"],
  ["Other", () => true],
];

const groups = new Map<string, string[]>(sections.map(([name]) => [name, []]));
for (const title of titles) {
  // the version bump is the release itself
  if (/^chore: release \S+( \(#\d+\))?$/.test(title)) continue;
  const m = /^(\w+)(?:\(([^)]+)\))?(!)?: (.*?)(?: \(#(\d+)\))?$/.exec(title);
  const e: Entry = m ? { type: m[1], scope: m[2], breaking: !!m[3], summary: m[4], pr: m[5] } : { summary: title };
  const [name] = sections.find(([, matches]) => matches(e))!;
  const scope = e.scope && e.scope !== "deps" ? `**${e.scope}:** ` : "";
  groups.get(name)!.push(`- ${scope}${e.summary}${e.pr ? ` ([#${e.pr}](${REPO}/pull/${e.pr}))` : ""}`);
}

const out: string[] = [];
for (const [name, lines] of groups) if (lines.length) out.push(`## ${name}\n\n${lines.join("\n")}\n`);
out.push(`**Full list:** ${REPO}/compare/${since}...${next ?? end}`);
console.log(out.join("\n"));
