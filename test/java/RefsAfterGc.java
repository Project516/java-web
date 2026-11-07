import java.lang.ref.PhantomReference;
import java.lang.ref.Reference;
import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;

// Weak and phantom references whose referents System.gc() collects are
// cleared, and both are enqueued.
public class RefsAfterGc {
  static WeakReference<Object> weak(ReferenceQueue<Object> q) {
    return new WeakReference<>(new Object(), q);
  }

  static PhantomReference<Object> phantom(ReferenceQueue<Object> q) {
    return new PhantomReference<>(new Object(), q);
  }

  public static void main(String[] args) throws InterruptedException {
    ReferenceQueue<Object> q = new ReferenceQueue<>();
    WeakReference<Object> w = weak(q);
    PhantomReference<Object> p = phantom(q);
    System.gc();
    System.out.println("weak cleared " + (w.get() == null));
    System.out.println("phantom get " + p.get());
    int n = 0;
    while (n < 2) {
      Reference<?> r = q.remove(10000);
      if (r == null) break;
      n++;
    }
    System.out.println("enqueued " + n);
  }
}
