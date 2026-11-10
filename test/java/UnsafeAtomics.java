import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicIntegerArray;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicLongArray;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicReferenceArray;
import java.util.concurrent.atomic.LongAdder;

public class UnsafeAtomics {
  static final class Cell {
    int i = Integer.MAX_VALUE - 2;
    long l = Long.MAX_VALUE - 2;
    Object r = "start";
    boolean z;
    byte b = 120;
    short s = 32760;
    char c = 65530;
    float f = 1.5f;
    double d = 2.5;
  }

  static final VarHandle I, L, R, Z, B, S, C, F, D, IA, LA, RA;
  static {
    try {
      MethodHandles.Lookup lk = MethodHandles.lookup();
      I = lk.findVarHandle(Cell.class, "i", int.class);
      L = lk.findVarHandle(Cell.class, "l", long.class);
      R = lk.findVarHandle(Cell.class, "r", Object.class);
      Z = lk.findVarHandle(Cell.class, "z", boolean.class);
      B = lk.findVarHandle(Cell.class, "b", byte.class);
      S = lk.findVarHandle(Cell.class, "s", short.class);
      C = lk.findVarHandle(Cell.class, "c", char.class);
      F = lk.findVarHandle(Cell.class, "f", float.class);
      D = lk.findVarHandle(Cell.class, "d", double.class);
      IA = MethodHandles.arrayElementVarHandle(int[].class);
      LA = MethodHandles.arrayElementVarHandle(long[].class);
      RA = MethodHandles.arrayElementVarHandle(Object[].class);
    } catch (ReflectiveOperationException e) {
      throw new ExceptionInInitializerError(e);
    }
  }

  static void modes() {
    Cell c = new Cell();
    System.out.println((int) I.getAndAdd(c, 5) + " " + (int) I.getAndAddAcquire(c, 1) + " " + (int) I.getAndAddRelease(c, -3) + " " + c.i);
    System.out.println((long) L.getAndAdd(c, 5L) + " " + (long) L.getAndAddAcquire(c, 1L) + " " + (long) L.getAndAddRelease(c, -3L) + " " + c.l);
    System.out.println((int) I.getAndSet(c, 7) + " " + (int) I.getAndSetAcquire(c, 8) + " " + (int) I.getAndSetRelease(c, 9) + " " + c.i);
    System.out.println((long) L.getAndSet(c, 7L) + " " + (long) L.getAndSetAcquire(c, 8L) + " " + (long) L.getAndSetRelease(c, 9L) + " " + c.l);
    System.out.println(R.getAndSet(c, "a") + " " + R.getAndSetAcquire(c, "b") + " " + R.getAndSetRelease(c, "c") + " " + c.r);
    System.out.println(I.weakCompareAndSet(c, 9, 10) + " " + I.weakCompareAndSetPlain(c, 9, 11) + " " + I.weakCompareAndSetAcquire(c, 10, 12) + " " + I.weakCompareAndSetRelease(c, 12, 13) + " " + c.i);
    System.out.println(L.weakCompareAndSet(c, 9L, 10L) + " " + L.weakCompareAndSetPlain(c, 9L, 11L) + " " + L.weakCompareAndSetAcquire(c, 10L, 12L) + " " + L.weakCompareAndSetRelease(c, 12L, 13L) + " " + c.l);
    System.out.println(R.weakCompareAndSet(c, "c", "d") + " " + R.weakCompareAndSetPlain(c, "c", "e") + " " + R.weakCompareAndSetAcquire(c, "d", "f") + " " + R.weakCompareAndSetRelease(c, "f", "g") + " " + c.r);
    System.out.println((int) I.compareAndExchange(c, 13, 14) + " " + (int) I.compareAndExchangeAcquire(c, 13, 15) + " " + (int) I.compareAndExchangeRelease(c, 14, 16) + " " + c.i);
    System.out.println((long) L.compareAndExchange(c, 13L, 14L) + " " + (long) L.compareAndExchangeAcquire(c, 13L, 15L) + " " + (long) L.compareAndExchangeRelease(c, 14L, 16L) + " " + c.l);
    System.out.println(R.compareAndExchange(c, "g", "h") + " " + R.compareAndExchangeAcquire(c, "g", "i") + " " + R.compareAndExchangeRelease(c, "h", "j") + " " + c.r);

    I.setRelease(c, 21); L.setRelease(c, 22L); R.setRelease(c, "rel"); Z.setRelease(c, true); B.setRelease(c, (byte) 23); S.setRelease(c, (short) 24);
    C.setRelease(c, (char) 25); F.setRelease(c, 26.5f); D.setRelease(c, 27.5);
    System.out.println((int) I.getAcquire(c) + " " + (long) L.getAcquire(c) + " " + R.getAcquire(c) + " " + (boolean) Z.getAcquire(c) + " " + (byte) B.getAcquire(c) + " " + (short) S.getAcquire(c)
        + " " + (int) (char) C.getAcquire(c) + " " + (float) F.getAcquire(c) + " " + (double) D.getAcquire(c));
    I.setOpaque(c, 31); L.setOpaque(c, 32L); R.setOpaque(c, "opq"); Z.setOpaque(c, false); B.setOpaque(c, (byte) 33); S.setOpaque(c, (short) 34);
    C.setOpaque(c, (char) 35); F.setOpaque(c, 36.5f); D.setOpaque(c, 37.5);
    System.out.println((int) I.getOpaque(c) + " " + (long) L.getOpaque(c) + " " + R.getOpaque(c) + " " + (boolean) Z.getOpaque(c) + " " + (byte) B.getOpaque(c) + " " + (short) S.getOpaque(c)
        + " " + (int) (char) C.getOpaque(c) + " " + (float) F.getOpaque(c) + " " + (double) D.getOpaque(c));

    System.out.println((byte) B.getAndAdd(c, (byte) 100) + " " + (short) S.getAndAdd(c, (short) 40000) + " " + (int) (char) C.getAndAdd(c, (char) 70000));
    System.out.println(c.b + " " + c.s + " " + (int) c.c);
    System.out.println((boolean) Z.getAndSet(c, true) + " " + (boolean) Z.getAndSetAcquire(c, false) + " " + (byte) B.getAndSet(c, (byte) 5) + " " + (short) S.getAndSetRelease(c, (short) 6));

    int[] ia = new int[4];
    long[] la = new long[4];
    Object[] ra = new Object[4];
    System.out.println((int) IA.getAndAdd(ia, 2, 5) + " " + (int) IA.getAndAdd(ia, 2, Integer.MAX_VALUE) + " " + ia[2]);
    System.out.println((long) LA.getAndAdd(la, 1, Long.MAX_VALUE) + " " + (long) LA.getAndAdd(la, 1, 5L) + " " + la[1]);
    System.out.println(RA.getAndSet(ra, 3, "x") + " " + RA.compareAndSet(ra, 3, "x", "y") + " " + RA.getAcquire(ra, 3));
  }

  static void classes() {
    AtomicInteger ai = new AtomicInteger(Integer.MAX_VALUE - 1);
    AtomicLong al = new AtomicLong(Long.MAX_VALUE - 1);
    AtomicReference<String> ar = new AtomicReference<>("a");
    AtomicBoolean ab = new AtomicBoolean();
    LongAdder adder = new LongAdder();
    AtomicIntegerArray aia = new AtomicIntegerArray(8);
    AtomicLongArray ala = new AtomicLongArray(8);
    AtomicReferenceArray<String> ara = new AtomicReferenceArray<>(8);
    ConcurrentHashMap<Integer, String> chm = new ConcurrentHashMap<>();
    long sum = 0;
    for (int n = 0; n < 3000; n++) {
      sum += ai.incrementAndGet() + ai.getAndAdd(n) + ai.addAndGet(-n) + ai.getAndSet(n) + ai.updateAndGet(x -> x * 3 + 1) + ai.accumulateAndGet(n, Math::max);
      sum += al.incrementAndGet() + al.getAndAdd(n) + al.addAndGet(-n * 7L) + al.getAndSet(n) + al.updateAndGet(x -> x * 31 + 1) + al.accumulateAndGet(n, Math::max);
      sum += ar.getAndSet("s" + (n % 5)).length() + (ar.compareAndSet("s1", "t") ? 1 : 0) + (ar.weakCompareAndSetPlain("t", "u") ? 2 : 0) + ar.getAcquire().length();
      sum += ab.getAndSet(n % 2 == 0) ? 1 : 0;
      adder.add(n);
      sum += aia.getAndAdd(n & 7, n) + aia.incrementAndGet(n & 7) + (aia.compareAndSet(n & 7, 5, 6) ? 1 : 0);
      sum += ala.getAndAdd(n & 7, n) + ala.incrementAndGet(n & 7) + (ala.weakCompareAndSetPlain(n & 7, 5, 6) ? 1 : 0);
      sum += (ara.getAndSet(n & 7, "e" + n) == null ? 1 : 0) + (ara.compareAndSet(n & 7, "e" + n, "f") ? 1 : 0);
      chm.put(n % 100, "v" + n);
      sum += chm.getOrDefault(n % 50, "").length() + chm.size();
      if (n % 7 == 0) chm.remove(n % 100);
    }
    System.out.println(sum + " " + ai + " " + al + " " + ar + " " + ab + " " + adder.sum() + " " + aia + " " + ala + " " + ara + " " + chm.size());
  }

  public static void main(String[] args) {
    modes();
    classes();
  }
}
