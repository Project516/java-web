import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;
import java.lang.invoke.WrongMethodTypeException;
import java.nio.ByteOrder;

// VarHandle calls hot enough to be compiled: one call site fed different
// handles, field, static, array and byte-view handles, CAS and getAndAdd,
// exact handles that must reject a mismatched call, and failing accesses.
public class VarHandles {
  int count;
  long total;
  static int shared;

  static final VarHandle COUNT, TOTAL, SHARED, INTS, BE, LE;
  static {
    try {
      var l = MethodHandles.lookup();
      COUNT = l.findVarHandle(VarHandles.class, "count", int.class);
      TOTAL = l.findVarHandle(VarHandles.class, "total", long.class);
      SHARED = l.findStaticVarHandle(VarHandles.class, "shared", int.class);
      INTS = MethodHandles.arrayElementVarHandle(int[].class);
      BE = MethodHandles.byteArrayViewVarHandle(int[].class, ByteOrder.BIG_ENDIAN);
      LE = MethodHandles.byteArrayViewVarHandle(int[].class, ByteOrder.LITTLE_ENDIAN);
    } catch (ReflectiveOperationException e) {
      throw new ExceptionInInitializerError(e);
    }
  }

  // one call site, whichever handle it is given
  static void put(VarHandle h, byte[] b, int at, int v) {
    h.set(b, at, v);
  }

  static int get(VarHandle h, byte[] b, int at) {
    return (int) h.get(b, at);
  }

  public static void main(String[] args) {
    VarHandles o = new VarHandles();
    int[] ints = new int[8];
    byte[] b = new byte[16];
    long mix = 0;
    for (int i = 0; i < 30000; i++) {
      COUNT.set(o, (int) COUNT.get(o) + 1);
      TOTAL.getAndAdd(o, (long) i);
      SHARED.compareAndSet(i, i + 1);
      INTS.set(ints, i & 7, i);
      VarHandle h = (i & 1) == 0 ? BE : LE;
      put(h, b, i % 13, i);
      mix = mix * 31 + get(h, b, i % 13) + get((i & 2) == 0 ? LE : BE, b, 4);
    }
    System.out.println(o.count + " " + o.total + " " + shared + " " + java.util.Arrays.toString(ints) + " " + mix);

    VarHandle exact = COUNT.withInvokeExactBehavior();
    int wrong = 0, oob = 0;
    for (int i = 0; i < 20000; i++) {
      exact.set(o, i);
      try {
        Object boxed = exact.get(o);
        if (boxed == null) throw new AssertionError();
      } catch (WrongMethodTypeException e) {
        wrong++;
      }
      try {
        put(BE, b, 13 + (i & 3), i);
      } catch (IndexOutOfBoundsException e) {
        oob++;
      }
    }
    System.out.println(o.count + " wrong type " + wrong + " out of bounds " + oob);
  }
}
