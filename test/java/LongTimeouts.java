import java.util.concurrent.locks.LockSupport;

// Timeouts longer than a host timer can hold must not wake early.
public class LongTimeouts {
    static volatile boolean interrupting;

    static String how(boolean interrupted) {
        return interrupting && interrupted ? "interrupt" : "early";
    }

    public static void main(String[] args) throws Exception {
        String[] result = new String[4];
        Object lock = new Object();
        Thread[] threads = {
            new Thread(() -> {
                LockSupport.parkNanos(Long.MAX_VALUE);
                result[0] = how(Thread.currentThread().isInterrupted());
            }),
            new Thread(() -> {
                LockSupport.parkUntil(Long.MAX_VALUE);
                result[1] = how(Thread.currentThread().isInterrupted());
            }),
            new Thread(() -> {
                synchronized (lock) {
                    try {
                        lock.wait(Long.MAX_VALUE / 2);
                        result[2] = "early";
                    } catch (InterruptedException e) {
                        result[2] = how(true);
                    }
                }
            }),
            new Thread(() -> {
                try {
                    Thread.sleep(Long.MAX_VALUE);
                    result[3] = "early";
                } catch (InterruptedException e) {
                    result[3] = how(true);
                }
            }),
        };
        for (Thread t : threads) t.start();
        Thread.sleep(300);
        interrupting = true;
        for (Thread t : threads) t.interrupt();
        for (Thread t : threads) t.join();
        String[] names = { "parkNanos", "parkUntil", "wait", "sleep" };
        for (int i = 0; i < 4; i++) System.out.println(names[i] + ": " + result[i]);
    }
}
