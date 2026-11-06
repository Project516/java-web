import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.LockSupport;

// Virtual threads and monitors on one carrier: a thread blocked on a contended
// synchronized or in Object.wait leaves the carrier free for other virtual
// threads, Thread.getState reports it, and notify, timed wait, interrupt and
// holdsLock behave as for platform threads.
public class VirtualMonitors {
  static void until(Thread t, Thread.State s) throws Exception {
    while (t.getState() != s) Thread.sleep(1);
  }

  static void say(String s) {
    System.out.println(s);
  }

  public static void main(String[] args) throws Exception {
    System.setProperty("jdk.virtualThreadScheduler.parallelism", "1");
    System.setProperty("jdk.virtualThreadScheduler.maxPoolSize", "1");
    System.setProperty("jdk.virtualThreadScheduler.minRunnable", "1");

    // contended enter: the blocked thread does not hold the only carrier
    Object lock = new Object();
    Thread blocked;
    synchronized (lock) {
      blocked = Thread.ofVirtual().name("blocked").start(() -> {
        synchronized (lock) {
          say("blocked entered, holds " + Thread.holdsLock(lock));
        }
      });
      until(blocked, Thread.State.BLOCKED);
      say("state " + blocked.getState());
      Thread other = Thread.ofVirtual().name("other").start(() -> say("other ran while blocked"));
      other.join();
      say("holds from main " + Thread.holdsLock(lock));
    }
    blocked.join();

    // wait and notify
    Object mon = new Object();
    boolean[] flag = new boolean[1];
    Thread waiter = Thread.ofVirtual().name("waiter").start(() -> {
      synchronized (mon) {
        try {
          while (!flag[0]) mon.wait();
        } catch (InterruptedException e) {
          say("unexpected interrupt");
        }
        say("waiter woke, holds " + Thread.holdsLock(mon));
      }
    });
    until(waiter, Thread.State.WAITING);
    say("state " + waiter.getState());
    Thread.ofVirtual().start(() -> say("other ran while waiting")).join();
    synchronized (mon) {
      flag[0] = true;
      mon.notify();
      say("notified, waiter is " + (waiter.getState() == Thread.State.WAITING ? "waiting" : "blocked"));
      Thread.sleep(20);
      say("waiter still " + waiter.getState() + " while main holds the monitor");
    }
    waiter.join();

    // notifyAll wakes every waiter, one at a time through the monitor
    Object all = new Object();
    AtomicInteger woke = new AtomicInteger();
    boolean[] go = new boolean[1];
    List<Thread> ws = new ArrayList<>();
    for (int i = 0; i < 5; i++) {
      ws.add(Thread.ofVirtual().start(() -> {
        synchronized (all) {
          try {
            while (!go[0]) all.wait();
          } catch (InterruptedException e) {
            throw new RuntimeException(e);
          }
          woke.incrementAndGet();
        }
      }));
    }
    for (Thread t : ws) until(t, Thread.State.WAITING);
    synchronized (all) {
      go[0] = true;
      all.notifyAll();
    }
    for (Thread t : ws) t.join();
    say("woken " + woke.get());

    // timed wait
    Object timed = new Object();
    Thread tw = Thread.ofVirtual().start(() -> {
      synchronized (timed) {
        long t0 = System.nanoTime();
        try {
          timed.wait(60);
        } catch (InterruptedException e) {
          say("unexpected interrupt");
        }
        say("timed wait returned after at least 60 ms: " + ((System.nanoTime() - t0) >= 60_000_000L));
      }
    });
    until(tw, Thread.State.TIMED_WAITING);
    say("state " + tw.getState());
    tw.join();

    // timed wait ended by notify
    Thread tn = Thread.ofVirtual().start(() -> {
      synchronized (timed) {
        long t0 = System.nanoTime();
        try {
          timed.wait(60_000);
        } catch (InterruptedException e) {
          say("unexpected interrupt");
        }
        say("notified before the timeout: " + ((System.nanoTime() - t0) < 30_000_000_000L));
      }
    });
    until(tn, Thread.State.TIMED_WAITING);
    synchronized (timed) {
      timed.notify();
    }
    tn.join();

    // interrupt during wait
    Object intr = new Object();
    Thread iw = Thread.ofVirtual().start(() -> {
      synchronized (intr) {
        try {
          intr.wait();
          say("not interrupted");
        } catch (InterruptedException e) {
          say("interrupted, flag " + Thread.currentThread().isInterrupted() + ", holds " + Thread.holdsLock(intr));
        }
      }
    });
    until(iw, Thread.State.WAITING);
    iw.interrupt();
    iw.join();

    // a thread interrupted before it waits
    Thread pre = Thread.ofVirtual().start(() -> {
      Thread.currentThread().interrupt();
      synchronized (intr) {
        try {
          intr.wait();
        } catch (InterruptedException e) {
          say("interrupted before wait, flag " + Thread.currentThread().isInterrupted());
        }
      }
    });
    pre.join();

    // a thread that parks while holding a monitor lets another thread run
    // and a third block on the monitor
    Object held = new Object();
    Thread owner = Thread.ofVirtual().name("owner").start(() -> {
      synchronized (held) {
        LockSupport.park();
        say("owner resumed, holds " + Thread.holdsLock(held));
      }
    });
    until(owner, Thread.State.WAITING);
    Thread contender = Thread.ofVirtual().name("contender").start(() -> {
      synchronized (held) {
        say("contender entered");
      }
    });
    until(contender, Thread.State.BLOCKED);
    Thread.ofVirtual().start(() -> say("third ran")).join();
    say("main holds " + Thread.holdsLock(held));
    LockSupport.unpark(owner);
    owner.join();
    contender.join();

    // a yield while holding a monitor keeps it
    Object keep = new Object();
    int[] counter = new int[1];
    List<Thread> cs = new ArrayList<>();
    for (int i = 0; i < 20; i++) {
      cs.add(Thread.ofVirtual().start(() -> {
        for (int k = 0; k < 2000; k++) {
          synchronized (keep) {
            int v = counter[0];
            if (k % 100 == 0) Thread.yield();
            counter[0] = v + 1;
          }
        }
      }));
    }
    for (Thread t : cs) t.join();
    say("counter " + counter[0]);

    // nested monitors and recursion across a blocking enter
    Object a = new Object(), b = new Object();
    Thread nested;
    synchronized (b) {
      nested = Thread.ofVirtual().start(() -> {
        synchronized (a) {
          synchronized (a) {
            synchronized (b) {
              say("nested holds " + Thread.holdsLock(a) + " " + Thread.holdsLock(b));
            }
          }
          say("still holds a " + Thread.holdsLock(a));
        }
        say("released a " + !Thread.holdsLock(a));
      });
      until(nested, Thread.State.BLOCKED);
      say("main holds a " + Thread.holdsLock(a));
    }
    nested.join();

    // a synchronized method
    Thread sm = Thread.ofVirtual().start(VirtualMonitors::synced);
    sm.join();
    say("synced " + synced);

    // wait inside a static initializer has a native frame below it and pins the carrier
    Thread pin = Thread.ofVirtual().start(() -> say("pinned wait " + Pinned.value));
    pin.join();
  }

  static int synced;

  static synchronized void synced() {
    synced++;
    Thread.yield();
    synced++;
  }

  static class Pinned {
    static final int value;

    static {
      Object o = new Object();
      synchronized (o) {
        try {
          o.wait(20);
        } catch (InterruptedException e) {
          throw new RuntimeException(e);
        }
      }
      value = 7;
    }
  }
}
