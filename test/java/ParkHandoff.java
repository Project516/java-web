import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReferenceArray;
import java.util.concurrent.locks.LockSupport;

public class ParkHandoff {
    static volatile int turn;

    public static void main(String[] args) throws Exception {
        pingPong(false);
        pingPong(true);
        submitAndYield();
        spinningUnparkers();
        System.out.println("done");
    }

    // two threads hand a turn back and forth with park and unpark
    static void pingPong(boolean virtual) throws Exception {
        int rounds = 5000;
        turn = 0;
        Thread[] th = new Thread[2];
        for (int k = 0; k < 2; k++) {
            int me = k;
            Runnable body = () -> {
                for (int i = 0; i < rounds; i++) {
                    while (turn != me) LockSupport.park();
                    turn = 1 - me;
                    LockSupport.unpark(th[1 - me]);
                }
            };
            th[k] = virtual ? Thread.ofVirtual().unstarted(body) : new Thread(body);
        }
        th[0].start();
        th[1].start();
        th[0].join();
        th[1].join();
        System.out.println("pingPong " + virtual + " " + turn);
    }

    // a thread spinning on Thread.yield must let the pool worker it woke run
    static void submitAndYield() {
        ForkJoinPool pool = new ForkJoinPool(1);
        AtomicBoolean flag = new AtomicBoolean();
        for (int i = 0; i < 2000; i++) {
            flag.set(true);
            pool.execute(() -> flag.set(false));
            while (flag.get()) Thread.yield();
        }
        pool.shutdown();
        System.out.println("submitAndYield");
    }

    // parkers wait for unparkers that never stop spinning
    static void spinningUnparkers() throws Exception {
        int slots = 4, iterations = 2000;
        AtomicReferenceArray<Thread> parked = new AtomicReferenceArray<>(slots);
        AtomicBoolean done = new AtomicBoolean();
        Thread[] parkers = new Thread[slots];
        Thread[] unparkers = new Thread[slots];
        for (int k = 0; k < slots; k++) {
            parkers[k] = new Thread(() -> {
                Thread me = Thread.currentThread();
                for (int i = 0; i < iterations; i++) {
                    int j;
                    do {
                        j = (int) ((System.nanoTime() >>> 3) % slots);
                    } while (!parked.compareAndSet(j, null, me));
                    do {
                        LockSupport.park();
                    } while (parked.get(j) == me);
                }
            });
            unparkers[k] = new Thread(() -> {
                while (!done.get()) {
                    for (int j = 0; j < slots; j++) {
                        Thread p = parked.get(j);
                        if (p != null && parked.compareAndSet(j, p, null)) LockSupport.unpark(p);
                    }
                }
            });
        }
        for (Thread t : unparkers) t.start();
        for (Thread t : parkers) t.start();
        for (Thread t : parkers) t.join();
        done.set(true);
        for (Thread t : unparkers) t.join();
        System.out.println("spinningUnparkers");
    }
}
