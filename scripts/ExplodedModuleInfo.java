import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassTransform;
import java.lang.classfile.attribute.ModuleHashesAttribute;
import java.nio.file.Files;
import java.nio.file.Path;

// Drops ModuleHashes from module-info.class files, as a JDK exploded build
// has none: exploded modules cannot be hashed, and boot fails when java.base
// records hashes of other modules.
void main(String[] args) throws Exception {
  ClassFile cf = ClassFile.of();
  for (String a : args) {
    Path p = Path.of(a);
    var model = cf.parse(p);
    if (model.findAttribute(Attributes.moduleHashes()).isEmpty()) continue;
    Files.write(p, cf.transformClass(model, ClassTransform.dropping(e -> e instanceof ModuleHashesAttribute)));
  }
}
