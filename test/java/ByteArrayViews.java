import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.UUID;

public class ByteArrayViews {
  static final VarHandle SHORT_LE = MethodHandles.byteArrayViewVarHandle(short[].class, ByteOrder.LITTLE_ENDIAN);
  static final VarHandle SHORT_BE = MethodHandles.byteArrayViewVarHandle(short[].class, ByteOrder.BIG_ENDIAN);
  static final VarHandle CHAR_LE = MethodHandles.byteArrayViewVarHandle(char[].class, ByteOrder.LITTLE_ENDIAN);
  static final VarHandle CHAR_BE = MethodHandles.byteArrayViewVarHandle(char[].class, ByteOrder.BIG_ENDIAN);
  static final VarHandle INT_LE = MethodHandles.byteArrayViewVarHandle(int[].class, ByteOrder.LITTLE_ENDIAN);
  static final VarHandle INT_BE = MethodHandles.byteArrayViewVarHandle(int[].class, ByteOrder.BIG_ENDIAN);
  static final VarHandle LONG_LE = MethodHandles.byteArrayViewVarHandle(long[].class, ByteOrder.LITTLE_ENDIAN);
  static final VarHandle LONG_BE = MethodHandles.byteArrayViewVarHandle(long[].class, ByteOrder.BIG_ENDIAN);
  static final VarHandle FLOAT_LE = MethodHandles.byteArrayViewVarHandle(float[].class, ByteOrder.LITTLE_ENDIAN);
  static final VarHandle DOUBLE_BE = MethodHandles.byteArrayViewVarHandle(double[].class, ByteOrder.BIG_ENDIAN);

  public static void main(String[] args) {
    byte[] a = new byte[64];
    for (int i = 0; i < a.length; i++) a[i] = (byte) (i * 37 + 11);
    long sum = 0;
    for (int off = 0; off < 40; off++) {
      sum = sum * 31 + (short) SHORT_LE.get(a, off);
      sum = sum * 31 + (short) SHORT_BE.get(a, off);
      sum = sum * 31 + (char) CHAR_LE.get(a, off);
      sum = sum * 31 + (char) CHAR_BE.get(a, off);
      sum = sum * 31 + (int) INT_LE.get(a, off);
      sum = sum * 31 + (int) INT_BE.get(a, off);
      sum = sum * 31 + (long) LONG_LE.get(a, off);
      sum = sum * 31 + (long) LONG_BE.get(a, off);
      sum = sum * 31 + Float.floatToRawIntBits((float) FLOAT_LE.get(a, off));
      sum = sum * 31 + Double.doubleToRawLongBits((double) DOUBLE_BE.get(a, off));
    }
    System.out.println(sum);

    byte[] b = new byte[64];
    for (int off = 0; off < 40; off++) {
      SHORT_LE.set(b, off, (short) (0x8001 + off * 257));
      SHORT_BE.set(b, off + 2, (short) (0xfe02 - off));
      CHAR_LE.set(b, off + 3, (char) (0xff01 - off));
      CHAR_BE.set(b, off + 5, (char) (0x7f80 + off));
      INT_LE.set(b, off + 7, 0x80000001 + off * 65537);
      INT_BE.set(b, off + 11, 0x7ffffffe - off * 16777217);
      LONG_LE.set(b, off + 13, 0x8000000000000001L + off * 0x0101010101010101L);
      LONG_BE.set(b, off + 17, 0x7ffffffffffffffeL - off * 0x0100010001000101L);
      FLOAT_LE.set(b, off + 19, 1.5f * off - 20f);
      DOUBLE_BE.set(b, off + 23, 1e10 * off - 3.25);
      System.out.println(Arrays.hashCode(b));
    }

    ByteBuffer bb = ByteBuffer.wrap(new byte[48]);
    for (ByteOrder order : new ByteOrder[] { ByteOrder.BIG_ENDIAN, ByteOrder.LITTLE_ENDIAN }) {
      bb.order(order);
      for (int off = 1; off < 30; off += 3) {
        bb.putShort(off, (short) (off * 1111));
        bb.putChar(off + 2, (char) (off * 2222));
        bb.putInt(off + 4, off * 33333333);
        bb.putLong(off + 8, off * 4444444444444L);
        bb.putFloat(off + 16, off * 0.1f);
        bb.putDouble(off + 20, off * 0.01);
        System.out.println(bb.getShort(off) + " " + (int) bb.getChar(off + 2) + " " + bb.getInt(off + 4) + " " + bb.getLong(off + 8) + " " + bb.getFloat(off + 16) + " " + bb.getDouble(off + 20));
      }
      System.out.println(Arrays.hashCode(bb.array()));
    }

    int[] ints = new int[8];
    long[] longs = new long[4];
    ByteBuffer.wrap(new byte[32]).asIntBuffer().put(ints);
    ByteBuffer lb = ByteBuffer.allocate(32);
    lb.asLongBuffer().put(longs);

    UUID u = new UUID(0x0123456789abcdefL, 0xfedcba9876543210L);
    System.out.println(u + " " + UUID.nameUUIDFromBytes(a) + " " + UUID.fromString(u.toString()).equals(u));
  }
}
