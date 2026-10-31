import java.util.*;
import java.util.stream.*;

public class Walker {
    static List<String> walk() {
        return StackWalker.getInstance().walk(s -> s.map(f -> f.getClassName() + "." + f.getMethodName() + ":" + f.getLineNumber()).collect(Collectors.toList()));
    }

    static void inner(Runnable r) { r.run(); }

    static Class<?> caller() {
        return StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE).getCallerClass();
    }

    static class Helper {
        Class<?> ask() { return caller(); }
    }

    public static void main(String[] args) throws Exception {
        System.out.println(walk());
        inner(() -> System.out.println(walk()));
        System.out.println(caller().getName() + " " + new Helper().ask().getName());
        StackWalker sw = StackWalker.getInstance(Set.of(StackWalker.Option.RETAIN_CLASS_REFERENCE));
        sw.forEach(f -> System.out.println(f.getDeclaringClass().getSimpleName() + " " + f.getMethodName() + " " + f.getMethodType() + " " + f.getDescriptor() + " " + f.isNativeMethod()));
        System.out.println(sw.walk(s -> s.skip(1).findFirst()).isPresent());
        Object lock = new Object();
        Thread t = new Thread(() -> parked(lock), "parker");
        synchronized (lock) {
            t.start();
            lock.wait();
        }
        List<String> mine = new ArrayList<>();
        for (StackTraceElement e : t.getStackTrace()) if (e.getClassName().startsWith("Walker")) mine.add(e.getMethodName() + ":" + e.getLineNumber());
        System.out.println(mine);
        t.interrupt();
        t.join();
    }

    static void parked(Object lock) {
        synchronized (lock) { lock.notifyAll(); }
        try { Thread.sleep(60_000); } catch (InterruptedException e) { }
    }
}
