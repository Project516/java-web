import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassTransform;
import java.lang.classfile.attribute.ModuleHashesAttribute;
import java.nio.file.Files;
import java.nio.file.Path;

// Drop hashes of the original JDK modules before linking a different set.
void main(String[] args) throws Exception {
  ClassFile cf = ClassFile.of();
  for (String a : args) {
    Path p = Path.of(a);
    var model = cf.parse(p);
    if (model.findAttribute(Attributes.moduleHashes()).isEmpty()) continue;
    Files.write(p, cf.transformClass(model, ClassTransform.dropping(e -> e instanceof ModuleHashesAttribute)));
  }
}
