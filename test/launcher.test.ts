// The java launcher's options as the java-web command and the in-VM java take them,
// compared with HotSpot's: -m, --module-path, -version and the module options.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { hotspot } from "../scripts/hotspot.ts";

const root = join(import.meta.dirname, "..");
const node = join(root, "src", "node.ts");
const dir = mkdtempSync(join(tmpdir(), "launcher-"));
const mods = join(dir, "mods");
const classes = join(dir, "classes");

before(() => {
  const m = join(dir, "src", "app");
  mkdirSync(join(m, "app"), { recursive: true });
  writeFileSync(join(m, "module-info.java"), "module app { exports app; }\n");
  writeFileSync(join(m, "app", "Main.java"), `package app;
public class Main {
  public static void main(String[] args) throws Exception {
    Module m = Main.class.getModule();
    System.out.println(m.getName() + " " + m.isNamed() + " " + String.join(",", args));
    System.out.println(System.getProperty("jdk.module.main") + " " + ModuleLayer.boot().findModule("app").isPresent());
    if (args.length > 0 && args[0].equals("child")) {
      String java = System.getProperty("java.home") + "/bin/java";
      Process p = new ProcessBuilder(java, "-p", System.getProperty("jdk.module.path"), "-m", "app/app.Main", "grandchild").redirectErrorStream(true).start();
      System.out.print(new String(p.getInputStream().readAllBytes()));
      System.out.println("exit " + p.waitFor());
    }
  }
}
`);
  mkdirSync(classes, { recursive: true });
  mkdirSync(join(dir, "boot", "bp"), { recursive: true });
  writeFileSync(join(dir, "boot", "bp", "Hidden.java"), `package bp;
public class Hidden { public static String hello() { return "hello from " + Hidden.class.getClassLoader() + " " + Hidden.class.getModule().isNamed(); } }
`);
  writeFileSync(join(dir, "boot", "res.txt"), "resource\n");
  writeFileSync(join(classes, "UseBoot.java"), `public class UseBoot {
  public static void main(String[] a) throws Exception {
    System.out.println(bp.Hidden.hello());
    System.out.println(Class.forName("bp.Hidden", false, null).getName());
    System.out.println(ClassLoader.getSystemResource("res.txt") != null);
    System.out.println(Package.getPackage("bp") != null);
  }
}
`);
  writeFileSync(join(classes, "Plain.java"), "public class Plain { public static void main(String[] a) { System.out.println(\"plain \" + Plain.class.getModule().isNamed()); } }\n");
  execFileSync(hotspot("javac"), ["-d", join(mods, "app"), join(m, "module-info.java"), join(m, "app", "Main.java")]);
  execFileSync(hotspot("javac"), ["-d", join(dir, "boot"), join(dir, "boot", "bp", "Hidden.java")]);
  execFileSync(hotspot("javac"), ["-d", classes, "-cp", join(dir, "boot"), join(classes, "Plain.java"), join(classes, "UseBoot.java")]);
  execFileSync(hotspot("jar"), ["cf", join(dir, "boot.jar"), "-C", join(dir, "boot"), "bp", "-C", join(dir, "boot"), "res.txt"]);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const run = (java: string, args: string[]) => {
  const got = java === "hotspot" ? spawnSync(hotspot("java"), args, { encoding: "utf8" })
    : spawnSync(process.execPath, [node, ...args], { encoding: "utf8" });
  return { stdout: got.stdout, stderr: got.stderr, code: got.status };
};

for (const [name, args] of [
  ["-m with a class", () => ["-p", mods, "-m", "app/app.Main", "a", "b"]],
  ["--module=", () => ["--module-path", mods, "--module=app/app.Main", "x"]],
  ["-m, a nested -m child", () => ["-p", mods, "-m", "app/app.Main", "child"]],
  ["--add-modules on the class path", () => ["--module-path", mods, "--add-modules", "app", "-cp", classes, "Plain"]],
  ["--limit-modules", () => ["--limit-modules", "java.base", "-cp", classes, "Plain"]],
  ["-Xbootclasspath/a with a directory", () => [`-Xbootclasspath/a:${join(dir, "boot")}`, "-cp", classes, "UseBoot"]],
  ["-Xbootclasspath/a with a jar", () => [`-Xbootclasspath/a:${join(dir, "boot.jar")}`, "-cp", classes, "UseBoot"]],
  ["no such module", () => ["-p", mods, "-m", "missing/x.Main"]],
] as [string, () => string[]][]) {
  test(name, () => {
    const a = args();
    const ref = run("hotspot", a);
    assert.deepEqual(run("java-web", a), ref);
  });
}

test("-version prints three lines on stderr", () => {
  const ref = run("hotspot", ["-version"]);
  const got = run("java-web", ["-version"]);
  assert.equal(got.code, 0);
  assert.equal(got.stdout, "");
  const [first, second] = got.stderr.split("\n");
  assert.equal(first, ref.stderr.split("\n")[0]);
  assert.match(second, /^OpenJDK Runtime Environment /);
  assert.equal(got.stderr.split("\n").length, ref.stderr.split("\n").length);
});
