import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.LockSupport;

// Virtual threads on continuations: sleeping, Thread.currentThread() and
// thread locals while mounted, pinning in synchronized, executors, and a
// virtual thread's stack, from inside and while it is parked.
public class VirtualThreads {
  static final ThreadLocal<String> LOCAL = new ThreadLocal<>();

  public static void main(String[] args) throws Exception {
    AtomicInteger sum = new AtomicInteger();
    List<Thread> ts = new ArrayList<>();
    for (int i = 0; i < 20; i++) {
      int n = i;
      ts.add(Thread.ofVirtual().name("v" + i).start(() -> {
        try { Thread.sleep(10); } catch (InterruptedException e) { throw new RuntimeException(e); }
        sum.addAndGet(n);
      }));
    }
    for (Thread t : ts) t.join();
    System.out.println("sum " + sum);

    Thread info = Thread.ofVirtual().name("info").unstarted(() -> {
      LOCAL.set("mine");
      Thread.yield();
      System.out.println("virtual " + Thread.currentThread().isVirtual() + " name " + Thread.currentThread().getName() + " local " + LOCAL.get());
    });
    info.start();
    info.join();
    System.out.println("main local " + LOCAL.get() + " main virtual " + Thread.currentThread().isVirtual());

    Object lock = new Object();
    Thread pinned = Thread.ofVirtual().start(() -> { synchronized (lock) { LockSupport.parkNanos(5_000_000); } });
    pinned.join();
    System.out.println("pinned park done");

    try (var ex = Executors.newVirtualThreadPerTaskExecutor()) {
      List<Future<Integer>> fs = new ArrayList<>();
      for (int i = 0; i < 10; i++) { int n = i; fs.add(ex.submit(() -> { Thread.sleep(5); return n * n; })); }
      int s = 0;
      for (Future<Integer> f : fs) s += f.get();
      System.out.println("executor " + s);
    }

    Thread walk = Thread.ofVirtual().start(() -> {
      StackWalker.getInstance().forEach(f -> System.out.println("  walk " + f.getClassName() + "." + f.getMethodName()));
      System.out.println("  trace depth " + Thread.currentThread().getStackTrace().length);
    });
    walk.join();

    Thread parked = Thread.ofVirtual().start(LockSupport::park);
    while (parked.getState() != Thread.State.WAITING) Thread.sleep(1);
    for (StackTraceElement e : parked.getStackTrace()) System.out.println("  parked " + e.getClassName() + "." + e.getMethodName());
    LockSupport.unpark(parked);
    parked.join();
  }
}
