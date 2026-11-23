import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicIntegerFieldUpdater;
import java.util.concurrent.atomic.AtomicLongFieldUpdater;
import java.util.concurrent.atomic.AtomicReferenceFieldUpdater;

// Instance fields of every kind in classes of different shapes: reads, writes,
// inheritance, clone, reflection, field updaters, VarHandles, and an identity
// hash and a monitor taken on the same object in either order.
public class ObjectLayout {
  static class Empty { }

  static class Mixed implements Cloneable {
    boolean z; byte b; char c; short s; int i; long j; float f; double d; Object o; String str; int[] arr;
    volatile int vi; volatile long vj; volatile Object vo;

    @Override
    public Mixed clone() {
      try {
        return (Mixed) super.clone();
      } catch (CloneNotSupportedException e) {
        throw new AssertionError(e);
      }
    }

    @Override
    public String toString() {
      return z + " " + (int) b + " " + (int) c + " " + s + " " + i + " " + j + " " + f + " " + d + " " + o + " " + str
          + " " + (arr == null ? null : arr.length) + " " + vi + " " + vj + " " + vo;
    }
  }

  static class Base { int a = 1; long b = 2; Object c = "base"; }
  static class Middle extends Base { double d = 3.5; int e = 4; }
  static class Leaf extends Middle { Object f = "leaf"; long g = 5; float h = 6.25f; }
  static class OtherLeaf extends Middle { long f = 7; Object g = "other"; }

  static class Wide {
    int f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, f19;
    long g0 = 1, g1 = 2, g2 = 3;
    double h0 = 0.5, h1 = 1.5;
    Object o0 = "o0", o1;
  }

  static class Counter {
    volatile int count;
    volatile long total;
    volatile Object last;
  }

  static final AtomicIntegerFieldUpdater<Counter> COUNT = AtomicIntegerFieldUpdater.newUpdater(Counter.class, "count");
  static final AtomicLongFieldUpdater<Counter> TOTAL = AtomicLongFieldUpdater.newUpdater(Counter.class, "total");
  static final AtomicReferenceFieldUpdater<Counter, Object> LAST = AtomicReferenceFieldUpdater.newUpdater(Counter.class, Object.class, "last");

  static class Holder {
    volatile int x;
    long y;
    Object z;
  }

  public static void main(String[] args) throws Exception {
    Object empty = new Empty();
    System.out.println(empty.getClass().getName() + " " + (empty.hashCode() == empty.hashCode()));

    Mixed m = new Mixed();
    System.out.println(m);
    m.z = true; m.b = -5; m.c = 'x'; m.s = -300; m.i = Integer.MIN_VALUE; m.j = Long.MIN_VALUE; m.f = 1.5f; m.d = Math.PI;
    m.o = "obj"; m.str = "text"; m.arr = new int[3]; m.vi = 9; m.vj = 1L << 40; m.vo = m;
    Mixed copy = m.clone();
    m.i = 0;
    m.j = 0;
    System.out.println(copy + " " + (copy.vo == m) + " " + (copy.arr == m.arr));
    m.f = 0.1f;
    m.d = -0.0;
    System.out.println(m.f + " " + m.d + " " + (1 / m.d));
    m.d = 1e300 * 1e10;
    m.f = Float.NaN;
    System.out.println(m.d + " " + m.f);

    Base[] bases = { new Base(), new Middle(), new Leaf(), new OtherLeaf() };
    for (Base b : bases) {
      StringBuilder sb = new StringBuilder(b.getClass().getSimpleName()).append(' ').append(b.a).append(' ').append(b.b).append(' ').append(b.c);
      if (b instanceof Middle mid) sb.append(' ').append(mid.d).append(' ').append(mid.e);
      if (b instanceof Leaf l) sb.append(' ').append(l.f).append(' ').append(l.g).append(' ').append(l.h);
      if (b instanceof OtherLeaf l) sb.append(' ').append(l.f).append(' ').append(l.g);
      System.out.println(sb);
    }

    Wide w = new Wide();
    w.f19 = 19; w.g2 = Long.MAX_VALUE; w.h1 = 2.25; w.o1 = w;
    System.out.println(w.f0 + " " + w.f19 + " " + w.g0 + " " + w.g2 + " " + w.h0 + " " + w.h1 + " " + w.o0 + " " + (w.o1 == w));

    Counter c = new Counter();
    COUNT.incrementAndGet(c);
    COUNT.compareAndSet(c, 1, 5);
    TOTAL.addAndGet(c, 1L << 33);
    LAST.compareAndSet(c, null, "first");
    LAST.compareAndSet(c, "other", "second");
    System.out.println(c.count + " " + c.total + " " + c.last);

    Holder h = new Holder();
    VarHandle X = MethodHandles.lookup().findVarHandle(Holder.class, "x", int.class);
    VarHandle Y = MethodHandles.lookup().findVarHandle(Holder.class, "y", long.class);
    VarHandle Z = MethodHandles.lookup().findVarHandle(Holder.class, "z", Object.class);
    X.set(h, 3);
    System.out.println((int) X.getAndAdd(h, 4) + " " + h.x + " " + (int) X.getVolatile(h));
    Y.set(h, -1L);
    System.out.println((long) Y.compareAndExchange(h, -1L, 8L) + " " + h.y);
    System.out.println(Z.compareAndSet(h, null, "set") + " " + h.z);

    for (Field f : Mixed.class.getDeclaredFields()) {
      f.setAccessible(true);
      if (f.getName().equals("i")) f.setInt(copy, 77);
      if (f.getName().equals("str")) f.set(copy, "reflected");
      if (f.getName().equals("d")) f.setDouble(copy, 0.25);
    }
    Field jf = Mixed.class.getDeclaredField("j");
    jf.setAccessible(true);
    System.out.println(copy.i + " " + copy.str + " " + copy.d + " " + jf.getLong(copy) + " " + jf.get(copy).getClass().getSimpleName());

    Object o = new Object();
    int hash = o.hashCode();
    synchronized (o) {
      System.out.println(hash == o.hashCode());
      o.wait(1);
    }
    System.out.println(hash == System.identityHashCode(o));
    Object p = new Object();
    synchronized (p) {
      p.notifyAll();
    }
    int phash = p.hashCode();
    synchronized (p) {
      System.out.println(phash == p.hashCode());
    }
    System.out.println(Thread.holdsLock(p));

    WeakReference<Object> ref = new WeakReference<>(new Leaf());
    System.out.println(ref.get() != null || ref.get() == null);
    Thread t = new Thread(() -> { });
    t.start();
    t.join();
    System.out.println(t.getState());
    Class<?> k = Mixed.class;
    synchronized (k) {
      System.out.println(k.hashCode() == k.hashCode());
    }
  }
}
