// javac: --add-exports java.base/jdk.internal.vm=ALL-UNNAMED
// java: --add-exports java.base/jdk.internal.vm=ALL-UNNAMED
import jdk.internal.vm.Continuation;
import jdk.internal.vm.ContinuationScope;

// jdk.internal.vm.Continuation, which coroutine libraries run on: yields deep
// in the stack, exceptions, yields holding a monitor, interleaving, and stack
// traces across a continuation.
public class Continuations {
  static final ContinuationScope SCOPE = new ContinuationScope("test");
  static int total;

  static void recurse(int n) {
    if (n == 0) {
      for (int i = 0; i < 5; i++) { total += i; Continuation.yield(SCOPE); }
      return;
    }
    recurse(n - 1);
    total += n;
  }

  public static void main(String[] args) {
    StringBuilder log = new StringBuilder();
    Continuation c = new Continuation(SCOPE, () -> {
      for (int i = 0; i < 3; i++) { log.append("step").append(i).append(' '); Continuation.yield(SCOPE); }
      log.append("end ");
    });
    while (!c.isDone()) { c.run(); log.append("| "); }
    System.out.println(log);

    Continuation d = new Continuation(SCOPE, () -> recurse(50));
    int runs = 0;
    while (!d.isDone()) { d.run(); runs++; }
    System.out.println("deep runs " + runs + " total " + total);

    Continuation e = new Continuation(SCOPE, () -> { Continuation.yield(SCOPE); throw new IllegalStateException("boom"); });
    e.run();
    try { e.run(); } catch (IllegalStateException ex) { System.out.println("caught " + ex.getMessage() + " done " + e.isDone()); }

    Object lock = new Object();
    Continuation p = new Continuation(SCOPE, () -> { synchronized (lock) { Continuation.yield(SCOPE); } });
    try { p.run(); System.out.println("monitor yield ok done " + p.isDone()); } catch (IllegalStateException ex) { System.out.println("monitor: " + ex.getMessage()); }

    StringBuilder both = new StringBuilder();
    Continuation x = new Continuation(SCOPE, () -> { for (int i = 0; i < 3; i++) { both.append('x').append(i); Continuation.yield(SCOPE); } });
    Continuation y = new Continuation(SCOPE, () -> { for (int i = 0; i < 3; i++) { both.append('y').append(i); Continuation.yield(SCOPE); } });
    while (!x.isDone() || !y.isDone()) { if (!x.isDone()) x.run(); if (!y.isDone()) y.run(); }
    System.out.println("interleaved " + both);

    Continuation t = new Continuation(SCOPE, () -> {
      Continuation.yield(SCOPE);
      System.out.println("trace after yield");
      for (StackTraceElement s : new Exception().getStackTrace()) System.out.println("  " + s.getClassName() + "." + s.getMethodName());
    });
    t.run();
    t.run();
  }
}
