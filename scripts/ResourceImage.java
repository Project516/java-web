import java.io.IOException;
import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.attribute.ModuleAttribute;
import java.lang.constant.ModuleDesc;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.spi.ToolProvider;
import java.util.stream.Stream;

// Builds a jimage that holds only the non-class resources of an exploded
// modules/ directory, which is all jrt: URLs need. jlink insists that a
// module's packages match its resources, so each module goes in as a stub
// module-info plus its resources, with the target platform of the image.
// Args: <modules dir> <work dir> <output jimage>
void main(String[] args) throws Exception {
  Path modules = Path.of(args[0]), work = Path.of(args[1]), image = Path.of(args[2]);
  Path jmods = work.resolve("jmods");
  var javaBase = ClassFile.of().parse(modules.resolve("java.base/module-info.class"));
  String platform = javaBase.findAttribute(Attributes.moduleTarget()).orElseThrow().targetPlatform().stringValue();
  Files.createDirectories(jmods);
  List<String> names = new ArrayList<>();
  try (Stream<Path> dirs = Files.list(modules)) {
    for (Path dir : dirs.sorted().toList()) {
      String name = dir.getFileName().toString();
      Path classes = work.resolve("classes").resolve(name);
      int copied = 0;
      try (Stream<Path> files = Files.walk(dir)) {
        for (Path f : files.filter(Files::isRegularFile).toList()) {
          if (f.toString().endsWith(".class")) continue;
          Path to = classes.resolve(dir.relativize(f).toString());
          Files.createDirectories(to.getParent());
          Files.copy(f, to);
          copied++;
        }
      }
      if (copied == 0) continue;
      ModuleAttribute module = ModuleAttribute.of(ModuleDesc.of(name), b -> {
        b.moduleVersion(Runtime.version().toString());
        if (!name.equals("java.base")) b.requires(ModuleDesc.of("java.base"), ClassFile.ACC_MANDATED, null);
      });
      Files.write(classes.resolve("module-info.class"), ClassFile.of().buildModule(module));
      run("jmod", "create", "--target-platform", platform, "--class-path", classes.toString(), jmods.resolve(name + ".jmod").toString());
      names.add(name);
    }
  }
  Path linked = work.resolve("image");
  run("jlink", "--module-path", jmods.toString(), "--add-modules", String.join(",", names),
      "--output", linked.toString(), "--disable-plugin", "system-modules", "--disable-plugin", "generate-jli-classes");
  Files.createDirectories(image.getParent());
  Files.move(linked.resolve("lib/modules"), image, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
}

void run(String tool, String... args) throws IOException {
  int rc = ToolProvider.findFirst(tool).orElseThrow().run(System.out, System.err, args);
  if (rc != 0) throw new IOException(tool + " failed with exit code " + rc);
}
