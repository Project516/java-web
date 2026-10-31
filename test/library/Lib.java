// Static methods called from JS in library mode.
public class Lib {
  static int calls;

  public static String greet(String name) {
    calls++;
    return "hello " + name;
  }

  public static int add(int a, int b) {
    calls++;
    return a + b;
  }

  public static long add(long a, long b, long c) {
    return a + b + c;
  }

  public static boolean not(boolean b) {
    return !b;
  }

  public static String kind(int i) { return "int"; }
  public static String kind(long l) { return "long"; }
  public static String kind(double d) { return "double"; }
  public static String kind(String s) { return "String"; }

  public static int calls() {
    return calls;
  }

  public static void fail(String why) {
    throw new IllegalStateException(why);
  }

  static native String ping(String s);

  static native String far(String s);

  public static String viaFar(String s) {
    return "java got " + far(s);
  }

  public static String viaFarFailure() {
    try {
      return far(null);
    } catch (RuntimeException e) {
      return e.getMessage();
    }
  }

  public static String viaNative(String s) {
    return "java got " + ping(s);
  }

  public static String hello() {
    return "hello from java";
  }

  public static String join(String sep, String... parts) {
    return String.join(sep, parts);
  }

  public static int count(Object... xs) {
    return xs.length;
  }

  public static String pick(Object o) { return "Object"; }
  public static String pick(CharSequence s) { return "CharSequence"; }
  public static String pick(StringBuilder s) { return "StringBuilder"; }

  public static int sum(int[] xs) {
    int n = 0;
    for (int x : xs) n += x;
    return n;
  }

  public static long total(long[] xs) {
    long n = 0;
    for (long x : xs) n += x;
    return n;
  }

  public static void fill(byte[] b) {
    for (int i = 0; i < b.length; i++) b[i] = (byte) (i + 1);
  }

  public static void flip(boolean[] b) {
    for (int i = 0; i < b.length; i++) b[i] = !b[i];
  }

  public static void untouched(int[] xs) {}

  public static String[] words() {
    return new String[] {"x", "y"};
  }

  public static int[] ints() {
    return new int[] {4, 5, 6};
  }

  public static char[] chars() {
    return new char[] {'h', 'i'};
  }

  public static Object boxed(int which) {
    switch (which) {
      case 0: return Integer.valueOf(7);
      case 1: return Boolean.TRUE;
      case 2: return Double.valueOf(1.5);
      default: return Long.valueOf(1L << 40);
    }
  }

  public static String typeOf(Object o) {
    return o == null ? "null" : o.getClass().getSimpleName();
  }

  public static String texts(String[][] grid) {
    return grid.length + "x" + grid[0].length + grid[1][1];
  }

  public static final String KIND = "lib";
  public static int tally = 3;
  public static final StringBuilder LOG = new StringBuilder("log");

  public static class Counter implements Runnable {
    public int count;
    public String name;
    public int[] data = {1, 2, 3};
    public String[] tags = {"a", "b"};
    public Counter other;
    public static int made;

    public Counter() { this("anon"); }

    public Counter(String name) {
      this.name = name;
      made++;
    }

    public Counter(int start) {
      this.name = "n" + start;
      this.count = start;
      made++;
    }

    public int inc() { return ++count; }

    public Counter self() { return this; }

    public String describe(Counter other) { return name + "/" + other.name; }

    public String describe(String s) { return name + ":" + s; }

    public String join(String sep, String... parts) { return String.join(sep, parts); }

    public Object[] mixed() { return new Object[] {"s", 1, this, null}; }

    public void fail() throws java.io.IOException { throw new java.io.IOException("disk full"); }

    public void run() { count += 10; }

    public native String shout(String s);

    public String twice(String s) { return shout(shout(s)); }

    public String name() { return name; }
  }

  public static Counter make(String name) {
    return new Counter(name);
  }

  public static abstract class Shape {
    public abstract String name();
  }

  public static class Circle extends Shape {
    public String name() { return "circle"; }
  }

  public static Shape shape() {
    return new Circle();
  }
}
