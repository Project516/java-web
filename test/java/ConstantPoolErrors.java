// javac: --add-exports java.base/jdk.internal.access=ALL-UNNAMED --add-exports java.base/jdk.internal.reflect=ALL-UNNAMED
// java: --add-exports java.base/jdk.internal.access=ALL-UNNAMED --add-exports java.base/jdk.internal.reflect=ALL-UNNAMED
import java.util.concurrent.Callable;
import jdk.internal.access.SharedSecrets;
import jdk.internal.reflect.ConstantPool;

public class ConstantPoolErrors {
  static void check(String what, Callable<Object> c) {
    try {
      System.out.println(what + " -> " + c.call());
    } catch (Exception e) {
      System.out.println(what + " -> " + e);
    }
  }

  public static void main(String[] args) {
    ConstantPool cp = SharedSecrets.getJavaLangAccess().getConstantPool(ConstantPoolErrors.class);
    int size = cp.getSize();
    check("utf8 at 0", () -> cp.getUTF8At(0));
    check("utf8 at -1", () -> cp.getUTF8At(-1));
    check("int at size", () -> cp.getIntAt(size));
    check("long at 1", () -> cp.getLongAt(1));
    check("string at 1", () -> cp.getStringAt(1));
    check("class at 1", () -> cp.getClassAt(1));
    check("member at 1", () -> java.util.Arrays.toString(cp.getMemberRefInfoAt(1)));
    check("name and type at 1", () -> cp.getNameAndTypeRefInfoAt(1));
    check("tag at size", () -> cp.getTagAt(size));
    check("tag at 0", () -> cp.getTagAt(0));
  }
}
