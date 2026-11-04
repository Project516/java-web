import java.io.IOException;
import java.lang.module.ModuleDescriptor;
import java.lang.module.ModuleDescriptor.Requires;
import java.lang.module.ModuleFinder;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

// Copies the conf/, lib/ and legal/ files of the linked modules.
// Args: <JDK home> <modules extracted from its lib/modules> <root modules, comma separated> <output dir>
void main(String[] args) throws IOException {
  Path jdk = Path.of(args[0]), src = Path.of(args[1]), out = Path.of(args[3]);
  Map<String, ModuleDescriptor> all = new HashMap<>();
  ModuleFinder.of(src).findAll().forEach(r -> all.put(r.descriptor().name(), r.descriptor()));

  Set<String> keep = new TreeSet<>();
  Deque<String> todo = new ArrayDeque<>(List.of(args[2].split(",")));
  while (!todo.isEmpty()) {
    String name = todo.pop();
    ModuleDescriptor module = all.get(name);
    if (module == null) throw new IOException("no module " + name);
    if (!keep.add(name)) continue;
    for (Requires r : module.requires()) if (!r.modifiers().contains(Requires.Modifier.STATIC)) todo.push(r.name());
  }

  // Each module's files are listed in jdk.jlink as type|kind|hash or link target|path
  Path lists = src.resolve("jdk.jlink/jdk/tools/jlink/internal/runtimelink");
  for (String name : keep) {
    Path list = lists.resolve("fs_" + name + "_files");
    if (Files.notExists(list)) continue;
    for (String line : Files.readAllLines(list)) {
      String[] f = line.split("\\|");
      boolean data = switch (f[0]) {
        case "1", "3" -> true;
        case "6" -> !f[3].endsWith(".so") && !f[3].startsWith("lib/server/")
            && !List.of("lib/jexec", "lib/jspawnhelper", "lib/jrt-fs.jar").contains(f[3]);
        default -> false;
      };
      if (!data) continue;
      Path to = out.resolve(f[3]);
      Files.createDirectories(to.getParent());
      Files.copy(jdk.resolve(f[3]), to, LinkOption.NOFOLLOW_LINKS);
    }
  }


  String version = Files.readAllLines(jdk.resolve("release")).stream()
      .filter(l -> l.startsWith("JAVA_VERSION=")).findFirst().orElseThrow();
  Files.writeString(out.resolve("release"), version + "\nMODULES=\"" + String.join(" ", keep) + "\"\n");
}
