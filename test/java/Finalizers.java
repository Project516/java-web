import java.lang.ref.WeakReference;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

// Objects whose class has a finalizer are finalized once unreachable, with
// their fields and identity hash, after weak references to them are cleared.
// An object that finalize() makes reachable again is finalized only once.
public class Finalizers {
  static final Map<Integer, Integer> hashes = new ConcurrentHashMap<>();
  static final Map<Integer, String> finalized = new ConcurrentHashMap<>();
  static final Map<Integer, WeakReference<Item>> weaks = new ConcurrentHashMap<>();
  static final AtomicInteger runs = new AtomicInteger();
  static volatile Revived resurrected;

  static class Item {
    final int id;
    final String name;

    Item(int id, String name) {
      this.id = id;
      this.name = name;
      weaks.put(id, new WeakReference<>(this));
    }

    @Override
    protected void finalize() {
      String hash = hashes.get(id) == System.identityHashCode(this) ? "kept" : "changed";
      finalized.put(id, name + " weak " + weaks.get(id).get() + " hash " + hash);
      runs.incrementAndGet();
    }
  }

  static class Child extends Item {
    Child(int id) {
      super(id, "child");
    }

    @Override
    protected void finalize() {
      super.finalize();
      runs.incrementAndGet();
    }
  }

  static class Empty extends Item {
    Empty(int id) {
      super(id, "empty");
    }

    @Override
    protected void finalize() {}
  }

  static class Revived {
    final int id = 4;

    @Override
    protected void finalize() {
      resurrected = this;
      finalized.put(id, "revived");
      runs.incrementAndGet();
    }
  }

  // garbage is made in a helper so no live frame still holds it
  static void make() {
    for (Item i : new Item[] {new Item(1, "plain"), new Child(2), new Empty(3)}) hashes.put(i.id, System.identityHashCode(i));
    new Revived();
  }

  public static void main(String[] args) throws Exception {
    make();
    for (int i = 0; i < 200 && runs.get() < 4; i++) {
      System.gc();
      System.runFinalization();
      Thread.sleep(20);
    }
    System.out.println("revived " + resurrected.id);
    resurrected = null;
    for (int i = 0; i < 100; i++) {
      System.gc();
      System.runFinalization();
      Thread.sleep(10);
    }
    for (Map.Entry<Integer, String> e : new TreeMap<>(finalized).entrySet()) System.out.println(e.getKey() + " " + e.getValue());
    System.out.println("runs " + runs.get());
  }
}
