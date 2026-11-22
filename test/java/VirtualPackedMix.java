import java.util.concurrent.CountDownLatch;
import java.util.concurrent.locks.LockSupport;

// thousands of parked virtual threads whose frames include synchronized methods
// and a wait, so packed frames sit next to frames that hold a monitor
public class VirtualPackedMix {
    static final int COUNT = 2400;
    static final CountDownLatch parked = new CountDownLatch(COUNT);
    static final Object shared = new Object();
    static volatile boolean go;

    public static void main(String[] args) throws Exception {
        long[] sums = new long[COUNT];
        Thread[] threads = new Thread[COUNT];
        for (int i = 0; i < COUNT; i++) {
            int id = i;
            threads[i] = Thread.ofVirtual().start(() -> sums[id] = switch (id % 3) {
                case 0 -> new VirtualPackedMix().locked(id, 2.5 * id, "a" + id);
                case 1 -> waiting(id);
                default -> plain(id, 1L << 40, (float) id);
            });
        }
        parked.await();
        while (!allParked(threads)) Thread.sleep(10);
        for (int id : new int[] {3, 4, 5}) {
            StackTraceElement[] trace = threads[id].getStackTrace();
            boolean found = false;
            for (StackTraceElement e : trace) found |= e.getMethodName().equals(id % 3 == 0 ? "locked" : id % 3 == 1 ? "waiting" : "plain");
            System.out.println("trace " + id + " " + found);
        }
        go = true;
        synchronized (shared) { shared.notifyAll(); }
        for (Thread t : threads) LockSupport.unpark(t);
        long total = 0;
        for (int i = 0; i < COUNT; i++) {
            threads[i].join();
            total += sums[i];
        }
        System.out.println("total " + total);
    }

    static boolean allParked(Thread[] threads) {
        for (Thread t : threads) if (t.getState() != Thread.State.WAITING) return false;
        return true;
    }

    synchronized long locked(int id, double d, String s) {
        parked.countDown();
        while (!go) LockSupport.park();
        return id + (long) d + s.length();
    }

    static long waiting(int id) {
        synchronized (shared) {
            parked.countDown();
            while (!go) {
                try { shared.wait(); } catch (InterruptedException e) { return -1; }
            }
        }
        return id * 2L;
    }

    static long plain(int id, long l, float f) {
        return id + deeper(id, l, f);
    }

    static long deeper(int id, long l, float f) {
        long before = l + id;
        parked.countDown();
        while (!go) LockSupport.park();
        return before + (long) f;
    }
}
