import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.nio.file.Path;
import java.util.Set;
import java.util.stream.Collectors;

// Prints a jmod --hash-modules pattern for the modules a java.base
// module-info.class records hashes of, among the given ones.
// Args: <java.base module-info.class> <modules, space separated>
void main(String[] args) throws Exception {
  var hashes = ClassFile.of().parse(Path.of(args[0])).findAttribute(Attributes.moduleHashes()).orElseThrow();
  Set<String> linked = Set.of(args[1].split(" "));
  System.out.println(hashes.hashes().stream().map(h -> h.moduleName().name().stringValue())
      .filter(linked::contains).sorted().collect(Collectors.joining("|", "^(", ")$")));
}
