import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.LockSupport;

// thousands of parked virtual threads keep their locals and operand stacks
public class VirtualManyParked {
    static final int COUNT = 3000;

    public static void main(String[] args) throws Exception {
        CountDownLatch parked = new CountDownLatch(COUNT);
        AtomicLong sum = new AtomicLong();
        Thread[] threads = new Thread[COUNT];
        for (int i = 0; i < COUNT; i++) {
            int id = i;
            threads[i] = Thread.ofVirtual().start(() -> sum.addAndGet(descend(5, id, 1.5 * id, "s" + id, parked)));
        }
        parked.await();
        while (!allParked(threads)) Thread.sleep(10);
        StackTraceElement[] trace = threads[7].getStackTrace();
        System.out.println("frames " + (trace.length >= 6) + " " + trace[0].getClassName() + "." + trace[0].getMethodName());
        for (Thread t : threads) LockSupport.unpark(t);
        for (Thread t : threads) t.join();
        System.out.println("sum " + sum.get());
    }

    static boolean allParked(Thread[] threads) {
        for (Thread t : threads) if (t.getState() != Thread.State.WAITING) return false;
        return true;
    }

    static long descend(int depth, int id, double d, String s, CountDownLatch parked) {
        if (depth > 0) return id + descend(depth - 1, id + 1, d * 2, s + depth, parked) - 1;
        parked.countDown();
        LockSupport.park();
        return id + (long) d + s.length();
    }
}
