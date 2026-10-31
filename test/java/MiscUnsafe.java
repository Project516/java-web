import java.lang.reflect.Field;
import java.lang.reflect.RecordComponent;
import sun.misc.Unsafe;

// sun.misc.Unsafe as some libraries use it: build RecordComponent
// instances without a constructor.
public class MiscUnsafe {
  record Point(int x, String label) {}

  public static void main(String[] args) throws Exception {
    Field f = Unsafe.class.getDeclaredField("theUnsafe");
    f.setAccessible(true);
    Unsafe u = (Unsafe) f.get(null);

    RecordComponent rc = (RecordComponent) u.allocateInstance(RecordComponent.class);
    u.putObject(rc, u.objectFieldOffset(RecordComponent.class.getDeclaredField("clazz")), Point.class);
    u.putObject(rc, u.objectFieldOffset(RecordComponent.class.getDeclaredField("name")), "label");
    u.putObject(rc, u.objectFieldOffset(RecordComponent.class.getDeclaredField("type")), String.class);
    u.putObject(rc, u.objectFieldOffset(RecordComponent.class.getDeclaredField("accessor")), Point.class.getDeclaredMethod("label"));
    System.out.println(rc + " " + rc.getDeclaringRecord().getSimpleName() + " " + rc.getAccessor().invoke(new Point(1, "p")));

    for (RecordComponent c : Point.class.getRecordComponents()) System.out.println(c.getName() + " " + c.getType());
    System.out.println(Point.class.isRecord());
  }
}
