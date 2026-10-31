import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class Threads {
    static int counter = 0;

    public static void main(String[] args) throws Exception {
        Object lock = new Object();
        Thread[] ts = new Thread[4];
        for (int i = 0; i < ts.length; i++) {
            ts[i] = new Thread(() -> {
                for (int k = 0; k < 10000; k++) synchronized (lock) { counter++; }
            }, "worker-" + i);
            ts[i].start();
        }
        for (Thread t : ts) t.join();
        System.out.println("counter " + counter);

        BlockingQueue<Integer> q = new ArrayBlockingQueue<>(2);
        Thread producer = new Thread(() -> {
            try { for (int i = 0; i < 5; i++) q.put(i); q.put(-1); } catch (InterruptedException e) { }
        });
        producer.start();
        int sum = 0;
        for (int v; (v = q.take()) >= 0; ) sum += v;
        System.out.println("queue sum " + sum);

        ExecutorService pool = Executors.newFixedThreadPool(3);
        List<Future<Integer>> fs = new ArrayList<>();
        for (int i = 1; i <= 5; i++) { final int n = i; fs.add(pool.submit(() -> n * n)); }
        int total = 0;
        for (Future<Integer> f : fs) total += f.get();
        pool.shutdown();
        System.out.println("pool " + total + " " + pool.awaitTermination(5, TimeUnit.SECONDS));

        AtomicInteger ai = new AtomicInteger();
        AtomicLong al = new AtomicLong(5);
        AtomicReference<String> ar = new AtomicReference<>("a");
        ai.incrementAndGet(); al.addAndGet(10); ar.compareAndSet("a", "b");
        System.out.println(ai + " " + al + " " + ar);

        ConcurrentHashMap<String, Integer> chm = new ConcurrentHashMap<>();
        for (String w : "a b a c b a".split(" ")) chm.merge(w, 1, Integer::sum);
        System.out.println(new TreeMap<>(chm));

        CompletableFuture<String> cf = CompletableFuture.supplyAsync(() -> "hello").thenApply(String::toUpperCase);
        System.out.println(cf.get());

        Thread sleeper = new Thread(() -> {
            try { Thread.sleep(10000); System.out.println("woke normally"); }
            catch (InterruptedException e) { System.out.println("interrupted"); }
        });
        sleeper.start();
        Thread.sleep(20);
        sleeper.interrupt();
        sleeper.join();

        CountDownLatch latch = new CountDownLatch(2);
        new Thread(latch::countDown).start();
        new Thread(latch::countDown).start();
        latch.await();
        System.out.println("latch done " + Thread.currentThread().getName());

        final boolean[] ready = {false};
        Thread waiter = new Thread(() -> {
            synchronized (ready) {
                while (!ready[0]) { try { ready.wait(); } catch (InterruptedException e) { } }
                System.out.println("notified");
            }
        });
        waiter.start();
        Thread.sleep(5);
        synchronized (ready) { ready[0] = true; ready.notifyAll(); }
        waiter.join();
        // A thread ends while another holds its monitor between isAlive() and
        // wait(), as Thread.join does: the wakeup must come after the wait.
        Thread quick = new Thread(() -> { });
        long t0;
        synchronized (quick) {
            quick.start();
            boolean alive = quick.isAlive();
            Thread.sleep(50);
            t0 = System.nanoTime();
            if (alive) quick.wait(5000);
        }
        System.out.println("ended thread woke its joiner " + (System.nanoTime() - t0 < 2_000_000_000L) + ", alive " + quick.isAlive());
        ThreadLocal<Integer> tl = ThreadLocal.withInitial(() -> 42);
        System.out.println("tl " + tl.get());
        // main is the primordial thread, 3; system threads take later ids
        Set<Long> ids = new HashSet<>();
        boolean unique = true;
        for (Thread t : Thread.getAllStackTraces().keySet()) unique &= ids.add(t.threadId());
        System.out.println("main id " + Thread.currentThread().threadId() + ", unique " + unique + ", lowest " + java.util.Collections.min(ids));
    }
}
