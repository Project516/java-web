import java.lang.management.ManagementFactory;
import java.lang.management.MonitorInfo;
import java.lang.management.LockInfo;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.locks.LockSupport;
import java.util.concurrent.locks.ReentrantLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

// ThreadMXBean thread descriptions: deadlock detection over monitors and
// ownable synchronizers, and getThreadInfo and dumpAllThreads with locks.
// Hash codes and line numbers differ between runs, so they are not printed.
public class ThreadInfos {
  static final ThreadMXBean MX = ManagementFactory.getThreadMXBean();

  static class Res {}

  static class Holder extends Thread {
    Holder(String name) { super(name); setDaemon(true); }
  }

  static class MonitorLocker extends Holder {
    final Object first, second;
    final CyclicBarrier barrier;
    MonitorLocker(String name, Object first, Object second, CyclicBarrier barrier) {
      super(name);
      this.first = first;
      this.second = second;
      this.barrier = barrier;
    }
    @Override public void run() {
      synchronized (first) {
        await(barrier);
        synchronized (second) { }
      }
    }
  }

  static class LockLocker extends Holder {
    final ReentrantLock first, second;
    final CyclicBarrier barrier;
    LockLocker(String name, ReentrantLock first, ReentrantLock second, CyclicBarrier barrier) {
      super(name);
      this.first = first;
      this.second = second;
      this.barrier = barrier;
    }
    @Override public void run() {
      first.lock();
      await(barrier);
      second.lock();
    }
  }

  static class Waiter extends Holder {
    final Object lock;
    final long millis;
    Waiter(String name, Object lock, long millis) { super(name); this.lock = lock; this.millis = millis; }
    @Override public void run() {
      synchronized (lock) {
        try { lock.wait(millis); } catch (InterruptedException e) { }
      }
    }
  }

  static class Blocked extends Holder {
    final Object lock;
    Blocked(String name, Object lock) { super(name); this.lock = lock; }
    @Override public void run() { synchronized (lock) { } }
  }

  static class Sleeper extends Holder {
    Sleeper(String name) { super(name); }
    @Override public void run() { try { Thread.sleep(1_000_000); } catch (InterruptedException e) { } }
  }

  static class Parker extends Holder {
    final Object blocker;
    Parker(String name, Object blocker) { super(name); this.blocker = blocker; }
    @Override public void run() {
      if (blocker == null) LockSupport.park(); else LockSupport.park(blocker);
    }
  }

  static void await(CyclicBarrier b) {
    try { b.await(); } catch (Exception e) { throw new RuntimeException(e); }
  }

  static void until(Thread t, Thread.State state) throws Exception {
    while (t.getState() != state) Thread.sleep(5);
  }

  static List<String> names(long[] ids) {
    List<String> out = new ArrayList<>();
    if (ids != null) for (ThreadInfo i : MX.getThreadInfo(ids)) out.add(i.getThreadName());
    out.sort(null);
    return out;
  }

  static String lock(LockInfo l) { return l == null ? "-" : l.getClassName(); }

  static String frames(ThreadInfo i, int n) {
    StackTraceElement[] st = i.getStackTrace();
    StringBuilder sb = new StringBuilder();
    for (int k = 0; k < Math.min(n, st.length); k++) {
      if (k > 0) sb.append(" < ");
      sb.append(st[k].getClassName()).append('.').append(st[k].getMethodName());
    }
    return sb.toString();
  }

  static void describe(Thread t, boolean locks) {
    ThreadInfo i = locks
        ? MX.getThreadInfo(new long[] { t.threadId() }, true, true)[0]
        : MX.getThreadInfo(t.threadId(), 3);
    System.out.println(i.getThreadName() + ": " + i.getThreadState() + " lock=" + lock(i.getLockInfo())
        + " owner=" + i.getLockOwnerName() + " top=" + frames(i, 3));
    if (locks) {
      for (MonitorInfo m : i.getLockedMonitors()) {
        System.out.println("  monitor " + m.getClassName() + " depth=" + m.getLockedStackDepth()
            + " frame=" + m.getLockedStackFrame().getMethodName());
      }
      List<String> syncs = new ArrayList<>();
      for (LockInfo s : i.getLockedSynchronizers()) syncs.add(s.getClassName());
      syncs.sort(null);
      System.out.println("  synchronizers " + syncs);
    }
  }

  static synchronized void dumpInMethod() {
    ThreadInfo i = MX.getThreadInfo(new long[] { Thread.currentThread().threadId() }, true, false)[0];
    for (MonitorInfo m : i.getLockedMonitors()) {
      System.out.println("  method monitor " + m.getClassName() + " depth=" + m.getLockedStackDepth()
          + " frame=" + m.getLockedStackFrame().getMethodName());
    }
  }

  public static void main(String[] args) throws Exception {
    // monitor deadlock
    Object x = new Res(), y = new Res();
    CyclicBarrier b1 = new CyclicBarrier(2);
    Thread ma = new MonitorLocker("m-a", x, y, b1), mb = new MonitorLocker("m-b", y, x, b1);
    ma.start();
    mb.start();
    until(ma, Thread.State.BLOCKED);
    until(mb, Thread.State.BLOCKED);
    System.out.println("monitor deadlock: " + names(MX.findMonitorDeadlockedThreads()));
    System.out.println("deadlock: " + names(MX.findDeadlockedThreads()));
    describe(ma, true);
    describe(mb, true);

    // ReentrantLock deadlock: monitors alone do not see it
    ReentrantLock l1 = new ReentrantLock(), l2 = new ReentrantLock();
    CyclicBarrier b2 = new CyclicBarrier(2);
    Thread ra = new LockLocker("r-a", l1, l2, b2), rb = new LockLocker("r-b", l2, l1, b2);
    ra.start();
    rb.start();
    until(ra, Thread.State.WAITING);
    until(rb, Thread.State.WAITING);
    System.out.println("monitor deadlock: " + names(MX.findMonitorDeadlockedThreads()));
    System.out.println("deadlock: " + names(MX.findDeadlockedThreads()));
    describe(ra, true);
    describe(rb, true);

    // waiting, blocked, sleeping and parked threads
    Object cond = new Res();
    Thread w = new Waiter("waiter", cond, 0), tw = new Waiter("timed-waiter", new Res(), 1_000_000);
    w.start();
    tw.start();
    until(w, Thread.State.WAITING);
    until(tw, Thread.State.TIMED_WAITING);
    describe(w, true);
    describe(tw, false);
    Thread s = new Sleeper("sleeper"), p = new Parker("parker", null), pb = new Parker("parker-blocker", new Res());
    s.start();
    p.start();
    pb.start();
    until(s, Thread.State.TIMED_WAITING);
    until(p, Thread.State.WAITING);
    until(pb, Thread.State.WAITING);
    describe(s, false);
    describe(p, true);
    describe(pb, true);

    // the calling thread's own locks, in one frame and in a synchronized method
    Object mon = new Res();
    ReentrantReadWriteLock rw = new ReentrantReadWriteLock();
    Thread blocked;
    synchronized (mon) {
      synchronized (cond) {
        rw.writeLock().lock();
        blocked = new Blocked("blocked", mon);
        blocked.start();
        until(blocked, Thread.State.BLOCKED);
        describe(blocked, false);
        describe(Thread.currentThread(), true);
        dumpInMethod();
        rw.writeLock().unlock();
      }
    }
    until(blocked, Thread.State.TERMINATED);
    describe(Thread.currentThread(), true);

    // depth limits, missing threads, and dumpAllThreads
    long id = ma.threadId();
    System.out.println("depth 0: " + MX.getThreadInfo(id, 0).getStackTrace().length);
    System.out.println("depth 1: " + MX.getThreadInfo(id, 1).getStackTrace().length);
    System.out.println("blocked, depth 0: " + MX.getThreadInfo(id, 0).getThreadState());
    System.out.println("terminated: " + MX.getThreadInfo(blocked.threadId()));
    System.out.println("never started: " + MX.getThreadInfo(Long.MAX_VALUE));
    ThreadInfo[] all = MX.dumpAllThreads(true, true);
    List<String> found = new ArrayList<>();
    for (ThreadInfo i : all) {
      if (Arrays.asList("main", "m-a", "m-b", "r-a", "r-b", "waiter", "sleeper", "blocked").contains(i.getThreadName())) {
        found.add(i.getThreadName());
      }
    }
    found.sort(null);
    System.out.println("dumpAllThreads: " + found);
    System.out.println("no locks: " + (MX.dumpAllThreads(false, false).length >= found.size()));
  }
}
