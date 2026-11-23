import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

// The main thread spins on notify() while virtual threads wait on the same
// locks; the spinning must not hold up the threads it wakes.
public class SpinningNotifier {
    public static void main(String[] args) {
        int threads = 3000;
        Object[] locks = {new Object(), new Object(), new Object(), new Object()};
        var finished = new AtomicInteger();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            for (int i = 0; i < threads; i++) {
                Object lock = locks[i % locks.length];
                executor.submit(() -> {
                    synchronized (lock) {
                        lock.wait(Long.MAX_VALUE);
                    }
                    finished.incrementAndGet();
                    return null;
                });
                synchronized (lock) {
                    lock.notify();
                }
            }
            while (finished.get() < threads) {
                for (Object lock : locks) {
                    synchronized (lock) {
                        lock.notify();
                    }
                }
            }
        }
        System.out.println("finished " + finished.get());
    }
}
