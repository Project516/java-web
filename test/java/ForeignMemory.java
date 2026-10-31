// java: --enable-native-access=ALL-UNNAMED
import java.lang.foreign.Arena;
import java.lang.foreign.FunctionDescriptor;
import java.lang.foreign.Linker;
import java.lang.foreign.MemoryLayout;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.SymbolLookup;
import java.lang.foreign.ValueLayout;
import java.lang.invoke.MethodHandle;
import java.lang.invoke.VarHandle;

// java.lang.foreign without native code, as some libraries' static initializers
// use it: the linker, symbol lookups, layouts, downcall handles (made, not
// called) and memory segments of every arena kind.
public class ForeignMemory {
  public static void main(String[] args) throws Throwable {
    Linker linker = Linker.nativeLinker();
    System.out.println("linker " + (linker != null));
    SymbolLookup loader = SymbolLookup.loaderLookup();
    System.out.println("loader lookup missing " + loader.find("no_such_symbol_xyz").isPresent());
    FunctionDescriptor fd = FunctionDescriptor.of(ValueLayout.JAVA_INT, ValueLayout.ADDRESS, ValueLayout.JAVA_DOUBLE);
    System.out.println("descriptor " + fd);
    MethodHandle h = linker.downcallHandle(MemorySegment.ofAddress(0x1000), fd);
    System.out.println("handle type " + h.type());
    System.out.println("unbound type " + linker.downcallHandle(FunctionDescriptor.ofVoid(ValueLayout.JAVA_LONG)).type());
    System.out.println("canonical long " + linker.canonicalLayouts().get("long") + " size_t " + linker.canonicalLayouts().get("size_t"));
    try (Arena arena = Arena.ofConfined()) {
      MemorySegment seg = arena.allocate(64, 8);
      seg.set(ValueLayout.JAVA_INT, 0, 42);
      seg.set(ValueLayout.JAVA_DOUBLE, 8, 2.5);
      seg.set(ValueLayout.JAVA_LONG, 16, -7L);
      seg.set(ValueLayout.JAVA_BYTE, 24, (byte) 9);
      System.out.println("confined " + seg.get(ValueLayout.JAVA_INT, 0) + " " + seg.get(ValueLayout.JAVA_DOUBLE, 8) + " " + seg.get(ValueLayout.JAVA_LONG, 16) + " " + seg.get(ValueLayout.JAVA_BYTE, 24) + " size " + seg.byteSize());
      MemorySegment s = arena.allocateFrom("hello");
      System.out.println("string " + s.getString(0) + " len " + s.byteSize());
      MemorySegment ints = arena.allocateFrom(ValueLayout.JAVA_INT, 1, 2, 3);
      System.out.println("ints " + ints.getAtIndex(ValueLayout.JAVA_INT, 2));
      MemoryLayout point = MemoryLayout.structLayout(ValueLayout.JAVA_INT.withName("x"), ValueLayout.JAVA_INT.withName("y"));
      VarHandle y = point.varHandle(MemoryLayout.PathElement.groupElement("y"));
      MemorySegment p = arena.allocate(point);
      y.set(p, 0L, 77);
      System.out.println("struct y " + y.get(p, 0L) + " size " + point.byteSize());
      MemorySegment slice = seg.asSlice(8, 8);
      System.out.println("slice " + slice.get(ValueLayout.JAVA_DOUBLE, 0));
    }
    MemorySegment heap = MemorySegment.ofArray(new long[] {5, 6});
    System.out.println("heap " + heap.get(ValueLayout.JAVA_LONG, 8) + " native " + heap.isNative());
    MemorySegment auto = Arena.ofAuto().allocate(16);
    auto.fill((byte) 1);
    System.out.println("auto " + auto.get(ValueLayout.JAVA_BYTE, 15));
    MemorySegment global = Arena.global().allocate(ValueLayout.JAVA_SHORT);
    global.set(ValueLayout.JAVA_SHORT, 0, (short) 300);
    System.out.println("global " + global.get(ValueLayout.JAVA_SHORT, 0));
    try {
      MemorySegment closed;
      try (Arena a = Arena.ofConfined()) { closed = a.allocate(8); }
      closed.get(ValueLayout.JAVA_INT, 0);
    } catch (IllegalStateException e) {
      System.out.println("closed: " + e.getMessage());
    }
    try {
      Arena.ofConfined().allocate(4).get(ValueLayout.JAVA_LONG, 0);
    } catch (IndexOutOfBoundsException e) {
      System.out.println("bounds: " + e.getClass().getSimpleName());
    }
  }
}
