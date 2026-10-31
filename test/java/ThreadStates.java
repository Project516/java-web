import java.util.Map;

// Thread.getState() for blocked, waiting and timed waiting threads, and
// stack traces of all threads.
public class ThreadStates {
  static final Object lock = new Object();
  static final Object waitOn = new Object();

  static void until(Thread t, Thread.State s) throws InterruptedException {
    for (int i = 0; i < 500 && t.getState() != s; i++) Thread.sleep(10);
    System.out.println(t.getName() + " " + t.getState());
  }

  public static void main(String[] args) throws Exception {
    Thread blocked = new Thread(() -> { synchronized (lock) { } }, "blocked");
    Thread waiting = new Thread(() -> {
      synchronized (waitOn) {
        try { waitOn.wait(); } catch (InterruptedException e) { }
      }
    }, "waiting");
    Thread sleeping = new Thread(() -> {
      try { Thread.sleep(60000); } catch (InterruptedException e) { }
    }, "sleeping");
    synchronized (lock) {
      blocked.start();
      until(blocked, Thread.State.BLOCKED);
      waiting.start();
      until(waiting, Thread.State.WAITING);
      sleeping.start();
      until(sleeping, Thread.State.TIMED_WAITING);
      Map<Thread, StackTraceElement[]> all = Thread.getAllStackTraces();
      boolean mainFrame = false;
      for (StackTraceElement e : all.get(Thread.currentThread())) mainFrame |= e.getMethodName().equals("main");
      System.out.println("all threads include ours " + all.keySet().containsAll(java.util.List.of(blocked, waiting, sleeping)) + ", main frame " + mainFrame);
    }
    blocked.join();
    System.out.println("blocked " + blocked.getState());
    waiting.interrupt();
    sleeping.interrupt();
    waiting.join();
    sleeping.join();
    System.out.println("done " + waiting.getState() + " " + sleeping.getState() + " " + new Thread(() -> {}).getState());
  }
}
