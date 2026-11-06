import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

public class WarmVirtual {
  // Virtual threads that contend for a monitor and wait on it, then finish.
  public static String run() throws Exception {
    Object lock = new Object();
    int[] total = new int[1];
    boolean[] go = new boolean[1];
    List<Thread> threads = new ArrayList<>();
    for (int i = 0; i < 6; i++) {
      int n = i;
      threads.add(Thread.ofVirtual().start(() -> {
        synchronized (lock) {
          try {
            while (!go[0]) lock.wait();
          } catch (InterruptedException e) {
            throw new RuntimeException(e);
          }
          total[0] += n;
        }
      }));
    }
    for (Thread t : threads) while (t.getState() != Thread.State.WAITING) Thread.sleep(1);
    synchronized (lock) {
      go[0] = true;
      lock.notifyAll();
    }
    for (Thread t : threads) t.join();
    return IntStream.range(0, 40).mapToObj(i -> String.format("%02d", i)).collect(Collectors.joining(",")).length() + ":" + total[0];
  }
}
