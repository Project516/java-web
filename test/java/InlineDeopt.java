// Exceptions thrown inside methods the JIT inlines must look as if nothing
// was inlined: same messages, same stack frames, same handlers.
public class InlineDeopt {
  static int at(int[] a, int i) { return a[i]; }
  // thrown from often, so HotSpot's preallocated fast-throw exception stays out of the output
  static int atOften(int[] a, int i) { return a[i]; }
  static int div(int a, int b) { return a / b; }
  static int len(String s) { return s.length(); }
  static char second(String s) { return s.charAt(1); }
  static int checked(int i, int n) {
    if (i < 0 || i >= n) throw new IllegalArgumentException("bad " + i);
    return i * 2;
  }

  static void print(Throwable e) {
    System.out.println(e);
    StackTraceElement[] st = e.getStackTrace();
    for (int i = 0; i < Math.min(st.length, 6); i++) System.out.println("  at " + st[i]);
  }

  public static void main(String[] args) {
    int[] arr = {1, 2, 3};
    String[] words = {"alpha", "be", "gamma", "x"};
    long sum = 0;
    int caught = 0;
    for (int i = 0; i < 20000; i++) {
      String w = words[i & 3];
      sum += len(w) + w.length() + w.charAt(0) + w.hashCode() + div(i, 3) + checked(i & 7, 8) + at(arr, i % 3);
      try {
        sum += atOften(arr, i % 4);
      } catch (ArrayIndexOutOfBoundsException e) {
        caught++;
      }
      try {
        sum += second(w);
      } catch (StringIndexOutOfBoundsException e) {
        caught++;
      }
    }
    System.out.println(sum + " " + caught);
    try { "abc".charAt(7); } catch (RuntimeException e) { print(e); }
    try { second("x"); } catch (RuntimeException e) { print(e); }
    try { len(null); } catch (RuntimeException e) { print(e); }
    try { at(arr, -1); } catch (RuntimeException e) { print(e); }
    try { div(1, 0); } catch (RuntimeException e) { print(e); }
    try { checked(9, 8); } catch (RuntimeException e) { print(e); }
  }
}
