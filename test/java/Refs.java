import java.lang.ref.Cleaner;
import java.lang.ref.PhantomReference;
import java.lang.ref.Reference;
import java.lang.ref.ReferenceQueue;
import java.lang.ref.SoftReference;
import java.lang.ref.WeakReference;
import java.util.HashSet;
import java.util.Set;
import java.util.WeakHashMap;

// Weak and phantom references clear and enqueue once their referents are
// collected; soft references and strongly held referents stay.
public class Refs {
  static final ReferenceQueue<Object> queue = new ReferenceQueue<>();
  static final boolean[] cleaned = {false};

  // garbage is made in helpers so no live frame still holds it
  static WeakReference<Object> weakToGarbage() {
    return new WeakReference<>(new Object(), queue);
  }

  static PhantomReference<Object> phantomToGarbage() {
    return new PhantomReference<>(new Object(), queue);
  }

  static void putGarbage(WeakHashMap<Object, String> map) {
    map.put(new Object(), "garbage");
  }

  // a map dropped as a whole, whose value refers back to its key
  static WeakReference<Object> keyOfDroppedMap() {
    WeakHashMap<Object, Object[]> m = new WeakHashMap<>();
    Object key = new Object();
    m.put(key, new Object[] {key});
    return new WeakReference<>(key);
  }

  static WeakReference<Thread> finishedThread() throws InterruptedException {
    Thread t = new Thread(() -> {});
    t.start();
    t.join();
    return new WeakReference<>(t);
  }

  static void registerGarbage(Cleaner cleaner) {
    cleaner.register(new Object(), () -> {
      synchronized (cleaned) {
        cleaned[0] = true;
        cleaned.notifyAll();
      }
    });
  }

  public static void main(String[] args) throws Exception {
    Object strong = new Object();
    WeakReference<Object> kept = new WeakReference<>(strong, queue);
    WeakReference<Object> dropped = weakToGarbage();
    PhantomReference<Object> phantom = phantomToGarbage();
    SoftReference<Object> soft = new SoftReference<>(new Object());
    WeakHashMap<Object, String> map = new WeakHashMap<>();
    map.put(strong, "strong");
    putGarbage(map);
    registerGarbage(Cleaner.create());

    Set<Reference<?>> seen = new HashSet<>();
    for (int i = 0; i < 100 && seen.size() < 2; i++) {
      System.gc();
      Reference<?> r = queue.remove(50);
      if (r != null) seen.add(r);
    }
    System.out.println("dropped enqueued " + seen.contains(dropped) + ", cleared " + (dropped.get() == null));
    System.out.println("phantom enqueued " + seen.contains(phantom) + ", get " + phantom.get());
    System.out.println("kept " + (kept.get() == strong) + ", enqueued " + seen.contains(kept) + ", refersTo " + kept.refersTo(strong));
    System.out.println("soft " + (soft.get() != null));
    for (int i = 0; i < 100 && map.size() > 1; i++) {
      System.gc();
      Thread.sleep(20);
    }
    System.out.println("map " + map.size() + " " + map.get(strong));
    synchronized (cleaned) {
      for (int i = 0; i < 100 && !cleaned[0]; i++) {
        System.gc();
        cleaned.wait(50);
      }
    }
    System.out.println("cleaned " + cleaned[0]);
    WeakReference<Object> mapKey = keyOfDroppedMap();
    WeakReference<Thread> thread = finishedThread();
    for (int i = 0; i < 100 && (mapKey.get() != null || thread.get() != null); i++) {
      System.gc();
      Thread.sleep(20);
    }
    System.out.println("dropped map key cleared " + (mapKey.get() == null));
    System.out.println("finished thread cleared " + (thread.get() == null));
    kept.clear();
    System.out.println("after clear " + kept.get() + " " + kept.refersTo(null));
    Reference.reachabilityFence(strong);
  }
}
