public class LongToFloat {
  static float convert(long value) { return (float) value; }

  public static void main(String[] args) {
    long midpoint = (1L << 62) + (1L << 38);
    long[] values = {0, 1, -1, midpoint - 1, midpoint, midpoint + 1,
      -midpoint - 1, -midpoint, -midpoint + 1, Long.MIN_VALUE, Long.MAX_VALUE};
    for (int run = 0; run < 1000; run++) {
      for (long value : values) {
        int bits = Float.floatToRawIntBits(convert(value));
        if (run == 0 || run == 999) System.out.println(bits);
      }
    }
  }
}
