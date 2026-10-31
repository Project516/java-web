// Tiny methods the JIT inlines at hot call sites must keep Java semantics.
public class Inline {
  int x = 7;
  long big = -3L;

  static int unsigned(byte b) { return b & 0xff; }
  static int minusFive(int a) { return a - -5; }
  static int mix(int a, int b) { return (a * 31 + b) ^ (a >>> 3) << 2; }
  static long lmix(long a, int s) { return (a << s) + (a >> 1) - (a >>> 60); }
  static float fhalf(float f) { return f * 0.5f - 1f; }
  static double dmix(double a, double b) { return -a * b + a / b; }
  static short narrow(int a) { return (short) (a + 70000); }
  static char ch(int a) { return (char) a; }
  static byte by(int a) { return (byte) (a * 3); }
  static long widen(int a) { return (long) a * 3L; }
  static int fromLong(long a) { return (int) (a >> 3); }
  static int toInt(double d) { return (int) d; }
  int getX() { return x; }
  int plusX(int a) { return a + x; }
  long scaled(int a) { return big * a; }

  static class Sub extends Inline {
    @Override int getX() { return 100; }
  }

  public static void main(String[] args) {
    long sum = 0;
    double dsum = 0;
    Inline o = new Inline();
    Inline sub = new Sub();
    for (int i = -3000; i < 3000; i++) {
      sum += unsigned((byte) i) + minusFive(i) + mix(i, i * 7) + narrow(i * 1000) + ch(i * 977) + by(i);
      sum += lmix(i * 123456789L, i & 63) + widen(i) + fromLong(sum) + toInt(i * 1.7);
      sum += o.getX() + sub.getX() + o.plusX(i) + o.scaled(i);
      dsum += fhalf(i) + dmix(i, i + 0.25);
    }
    System.out.println(sum);
    System.out.println(dsum);
    System.out.println(toInt(Double.NaN) + " " + toInt(1e20) + " " + toInt(-1e20));
    Inline none = null;
    try {
      none.getX();
    } catch (NullPointerException e) {
      System.out.println("npe " + e.getMessage());
    }
  }
}
