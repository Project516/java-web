import java.util.Arrays;

// Compiled code calling methods still too cold to compile: results of each
// type, exceptions caught on either side with their stack traces, monitors,
// recursion, stack overflow and a callee that waits on another thread. Each
// callee calls pad, so it is too big to be inlined.
public class NestedCalls {
  static int counter, noise;
  static final Object LOCK = new Object();

  static void pad(int x) {
    noise += x * 3 + (x >>> 2) - (x ^ 5) + (x | 9) + (x & 0x77) + x % 13 + x / 7 + (x << 3) - (x >> 1);
  }

  static int i(int x) { pad(x); pad(x + 1); return x + 1; }
  static long j(long x) { pad((int) x); pad(1); return x * 3; }
  static double d(double x) { pad((int) x); pad(2); return x / 2; }
  static boolean z(int x) { pad(x); pad(3); return (x & 1) == 0; }
  static Object a(int x) { pad(x); pad(4); return x % 3 == 0 ? null : new int[] {x}; }
  static void v() { pad(5); pad(6); counter++; }

  static int throwsOut(int x) {
    pad(x);
    pad(7);
    if (x % 7 == 0) throw new IllegalStateException("x" + x);
    return x;
  }

  static int catchesInside(int x) {
    try {
      return throwsOut(x);
    } catch (IllegalStateException e) {
      return -1;
    }
  }

  static int npe(int[] a) { pad(8); pad(9); return a[0]; }

  // cold, called by compiled hotCaller, which is called by cold outerCatch:
  // its exception passes compiled code to reach outerCatch's handler
  static int coldThrow(int x) {
    pad(x);
    pad(10);
    if (x < 0) throw new IllegalArgumentException("neg " + x);
    return x;
  }

  static int hotCaller(int x, boolean call) {
    pad(x);
    pad(11);
    return call ? coldThrow(x) : x;
  }

  static int outerCatch(int x) {
    pad(x);
    try {
      return hotCaller(x, true);
    } catch (IllegalArgumentException e) {
      return e.getMessage().length() - 100;
    }
  }

  static int locked(int x) {
    synchronized (LOCK) {
      return x * 2;
    }
  }

  static synchronized int syncMethod(int x) { return x - 1; }

  static int depth(int n) { return n == 0 ? 0 : 1 + depth(n - 1); }

  static int forever(int n) { return forever(n + 1) + 1; }

  static long sum(int n) {
    long s = 0;
    for (int k = 0; k < n; k++) s += i(k) + depth(k & 15);
    return s;
  }

  static int joined(int x) throws InterruptedException {
    Thread t = new Thread(() -> counter += 1000);
    t.start();
    t.join();
    return x;
  }

  static String where(Throwable e) {
    StackTraceElement[] st = e.getStackTrace();
    return st[0].getMethodName() + ":" + st[0].getLineNumber() + " < " + st[1].getMethodName() + ":" + st[1].getLineNumber();
  }

  // compiled by its loop after the first pass resolves the calls and before
  // the others start
  static void run() throws InterruptedException {
    long acc = 0;
    double dacc = 0;
    int thrown = 0, inside = 0, nulls = 0;
    String firstThrow = null, firstNpe = null;
    for (int k = 0; k < 3000; k++) {
      acc += k & 3;
      if (k != 0 && (k < 2000 || k >= 2300)) continue;
      acc += i(k) + j(k) + (z(k) ? 1 : 0) + locked(k) + syncMethod(k) + depth(k & 31);
      dacc += d(k);
      v();
      Object o = a(k);
      if (o == null) nulls++;
      try {
        acc += throwsOut(k);
      } catch (IllegalStateException e) {
        thrown++;
        if (firstThrow == null) firstThrow = e.getMessage() + " at " + where(e);
      }
      if (catchesInside(k) < 0) inside++;
      try {
        acc += npe(k % 50 == 0 ? null : new int[] {k});
      } catch (NullPointerException e) {
        if (firstNpe == null) firstNpe = where(e);
      }
      if (k % 100 == 0) acc += joined(k);
      if (k % 10 == 0) acc += outerCatch(k % 20 == 0 ? -k : k);
    }
    System.out.println(acc + " " + dacc + " " + counter + " " + thrown + " " + inside + " " + nulls + " " + noise);
    System.out.println(firstThrow);
    System.out.println(firstNpe);
    System.out.println(sum(5000));
    try {
      forever(0);
    } catch (StackOverflowError e) {
      System.out.println("StackOverflowError");
    }
    System.out.println(Arrays.toString((int[]) a(4)));
  }

  public static void main(String[] args) throws InterruptedException {
    hotCaller(1, true);
    for (int k = 0; k < 600; k++) hotCaller(k, false);
    run();
  }
}
