import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.HexFormat;

// Multi-byte reads and writes at every alignment, in both byte orders, through
// byte array views, heap and direct buffers, and views of other element types,
// and native-order reads across the elements of other primitive arrays.
public class Unaligned {
  public static void main(String[] args) {
    HexFormat hex = HexFormat.of();
    for (ByteOrder order : new ByteOrder[] {ByteOrder.BIG_ENDIAN, ByteOrder.LITTLE_ENDIAN}) {
      VarHandle ints = MethodHandles.byteArrayViewVarHandle(int[].class, order);
      VarHandle longs = MethodHandles.byteArrayViewVarHandle(long[].class, order);
      VarHandle shorts = MethodHandles.byteArrayViewVarHandle(short[].class, order);
      VarHandle chars = MethodHandles.byteArrayViewVarHandle(char[].class, order);
      for (int at = 0; at < 8; at++) {
        byte[] b = new byte[24];
        ints.set(b, at, 0x81828384);
        longs.set(b, at + 4, 0x0102030405060708L);
        shorts.set(b, at + 12, (short) -2);
        chars.set(b, at + 14, 'ꯍ');
        System.out.println(order + " " + at + " " + hex.formatHex(b) + " " + Integer.toHexString((int) ints.get(b, at))
            + " " + Long.toHexString((long) longs.get(b, at + 4)) + " " + (short) shorts.get(b, at + 12)
            + " " + Integer.toHexString((char) chars.get(b, at + 14)) + " " + Long.toHexString((long) longs.get(b, at + 1)));
      }
      for (ByteBuffer buf : new ByteBuffer[] {ByteBuffer.allocate(32), ByteBuffer.allocateDirect(32)}) {
        buf.order(order);
        for (int at = 0; at < 5; at++) {
          buf.putLong(at, -0x123456789abcdefL).putInt(at + 9, 0x7f00ff01).putShort(at + 14, (short) 0x8001).putChar(at + 17, 'Z')
              .putDouble(at + 20, Math.PI).putFloat(at + 28 - at, 1.5f);
          System.out.println((buf.isDirect() ? "direct " : "heap ") + order + " " + at + " " + Long.toHexString(buf.getLong(at))
              + " " + buf.getInt(at + 9) + " " + buf.getShort(at + 14) + " " + buf.getChar(at + 17) + " " + buf.getDouble(at + 20)
              + " " + buf.getFloat(28) + " " + buf.getInt(at + 1));
        }
      }
      // a clone written through a view after the original was
      byte[] orig = new byte[8];
      ints.set(orig, 1, 0x11223344);
      byte[] copy = orig.clone();
      ints.set(copy, 1, 0x55667788);
      System.out.println(order + " clone " + hex.formatHex(orig) + " " + hex.formatHex(copy));
      // an int buffer over a byte buffer, read through a long view
      ByteBuffer bb = ByteBuffer.allocate(40).order(order);
      bb.asIntBuffer().put(new int[] {1, 2, 3, 4, 5, 6, 7, 8, 9, 10});
      System.out.println(order + " view " + Long.toHexString(bb.asLongBuffer().get(2)) + " " + bb.position(3).slice().order(order).getInt(0));
    }
    // Arrays.mismatch reads longs across the elements of int, char and short
    // arrays, from any starting element
    int[] ia = new int[40], ib = new int[40];
    char[] ca = new char[70], cb = new char[70];
    short[] sa = new short[70], sb = new short[70];
    StringBuilder out = new StringBuilder("mismatch");
    for (int diff = 0; diff < 40; diff += 3) {
      ib[diff] = ia[diff] + 1;
      cb[diff + 25] = 'x';
      sb[diff + 25] = -1;
      for (int from = 0; from < 5; from++) {
        out.append(' ').append(java.util.Arrays.mismatch(ia, from, 40, ib, from, 40))
            .append(',').append(java.util.Arrays.mismatch(ca, from, 70, cb, from + 1, 70))
            .append(',').append(java.util.Arrays.mismatch(sa, from, 70, sb, from, 70));
      }
      ib[diff] = ia[diff];
      cb[diff + 25] = 0;
      sb[diff + 25] = 0;
    }
    System.out.println(out);
  }
}
