import java.lang.ref.Reference;
import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;

// What a restored VM must still have: its command, properties, and the
// Reference Handler that was waiting when the snapshot was taken.
public class Boot {
  public static void main(String[] args) throws Exception {
    System.out.println(String.join(",", args));
    System.out.println(where());
    System.out.println(System.getProperty("snap.prop"));
    ReferenceQueue<Object> q = new ReferenceQueue<>();
    WeakReference<Object> w = new WeakReference<>(new Object(), q);
    Reference<?> r = null;
    for (int i = 0; i < 100 && (r = q.remove(10)) == null; i++) System.gc();
    System.out.println("enqueued " + (r == w));
    Thread t = new Thread(() -> System.out.println("thread " + Thread.currentThread().getName()), "worker");
    t.start();
    t.join();
  }

  static String where() {
    return System.getProperty("sun.java.command") + " on " + Thread.currentThread().getName();
  }
}
