import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.ForkJoinWorkerThread;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public class VirtualStackTrace {
    public static void main(String[] args) throws Exception {
        AtomicBoolean ready = new AtomicBoolean();
        AtomicBoolean done = new AtomicBoolean();
        Thread vt = Thread.ofVirtual().unstarted(() -> {
            ready.set(true);
            while (!done.get()) Thread.onSpinWait();
        });
        vt.start();
        while (!ready.get()) Thread.sleep(5);
        // the vthread is running: its trace is read off its carrier
        StackTraceElement[] st = vt.getStackTrace();
        StackTraceElement bottom = st[st.length - 1];
        // the top frame depends on where the spin loop is when sampled
        boolean lambda = false;
        for (StackTraceElement e : st) lambda |= e.getMethodName().startsWith("lambda$main");
        System.out.println("lambda " + lambda);
        System.out.println("bottom " + bottom.getClassName() + "." + bottom.getMethodName());
        done.set(true);
        vt.join();
        System.out.println("done");
    }
}
