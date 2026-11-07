// The default time zone from a TZ value that is a POSIX rule, not a zone ID,
// compared with HotSpot's.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { hotspot } from "../scripts/hotspot.ts";
import { posixOffsetMinutes } from "../src/posixtz.ts";

const dir = mkdtempSync(join(tmpdir(), "timezone-"));
before(() => {
  writeFileSync(join(dir, "Zone.java"), `import java.util.*;
public class Zone {
  public static void main(String[] a) {
    TimeZone tz = TimeZone.getDefault();
    long now = System.currentTimeMillis();
    System.out.println(tz.getID() + " " + tz.getOffset(now) + " " + new Date(now).toString().contains(tz.getID()));
  }
}
`);
  execFileSync(hotspot("javac"), ["-d", dir, join(dir, "Zone.java")]);
});
after(() => rmSync(dir, { recursive: true, force: true }));

// both hemispheres, a zone with no daylight time, one with the default rules
for (const tz of ["MEZ-1MESZ,M3.5.0,M10.5.0/3", "MEZ-1MESZ,M10.5.0,M3.5.0/3", "AAA-3", "AAA-1BBB,M1.1.0,M12.5.0", "AAA-1BBB,M12.5.0,M1.1.0", "AAA5BBB", "Europe/Berlin"]) {
  test(`TZ=${tz}`, () => {
    const run = (cmd: string, args: string[]) => {
      const got = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, TZ: tz } });
      return { stdout: got.stdout, code: got.status };
    };
    assert.deepEqual(
      run(process.execPath, [join(import.meta.dirname, "..", "src", "node.ts"), "-cp", dir, "Zone"]),
      run(hotspot("java"), ["-cp", dir, "Zone"]),
    );
  });
}

test("posixOffsetMinutes follows the rule dates", () => {
  const tz = "MEZ-1MESZ,M3.5.0,M10.5.0/3";
  assert.equal(posixOffsetMinutes(tz, Date.UTC(2026, 0, 15)), 60);
  assert.equal(posixOffsetMinutes(tz, Date.UTC(2026, 6, 15)), 120);
  // 2026-03-29 01:00 UTC is the switch
  assert.equal(posixOffsetMinutes(tz, Date.UTC(2026, 2, 29, 0, 59)), 60);
  assert.equal(posixOffsetMinutes(tz, Date.UTC(2026, 2, 29, 1, 0)), 120);
  // 2026-10-25 01:00 UTC is the switch back (03:00 local daylight time)
  assert.equal(posixOffsetMinutes(tz, Date.UTC(2026, 9, 25, 0, 59)), 120);
  assert.equal(posixOffsetMinutes(tz, Date.UTC(2026, 9, 25, 1, 0)), 60);
  assert.equal(posixOffsetMinutes("MEZ-1MESZ,M10.5.0,M3.5.0/3", Date.UTC(2026, 0, 15)), 120);
  assert.equal(posixOffsetMinutes("EST5EDT", Date.UTC(2026, 6, 15)), -240);
  assert.equal(posixOffsetMinutes("nonsense", 0), null);
  assert.equal(posixOffsetMinutes("", 0), null);
  assert.equal(posixOffsetMinutes("AAA5BBB,M3.2.0", 0), null);
  assert.equal(posixOffsetMinutes("AAA5BBB,M13.2.0,M11.1.0", 0), null);
  assert.equal(posixOffsetMinutes("AAA5BBB,M3.6.0,M11.1.0", 0), null);
  assert.equal(posixOffsetMinutes("AAA5BBB,M3.2.0/x,M11.1.0", 0), null);
  assert.equal(posixOffsetMinutes("AAA5BBB,M3.2.0/2/3,M11.1.0", 0), null);
  assert.equal(posixOffsetMinutes("AAA5BBB,J0,J300", 0), null);
});
