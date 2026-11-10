import java.util.function.IntSupplier;

public class JitGuardMiss {
  interface Shape {
    long area(long k, double d);
    double ratio(float f);
    boolean big(int n);
    int[] cells(int n);
    String name();
    void touch(int[] box);
  }

  static final class Sq implements Shape {
    final long s;
    Sq(long s) { this.s = s; }
    public long area(long k, double d) { return s * s + k + (long) d; }
    public double ratio(float f) { return s * 0.5 + f; }
    public boolean big(int n) { return s > n; }
    public int[] cells(int n) { return new int[] { n, (int) s }; }
    public String name() { return "sq" + s; }
    public void touch(int[] box) { box[0] += (int) s; }
  }

  static final class Circ implements Shape {
    final long r;
    Circ(long r) { this.r = r; }
    public long area(long k, double d) { return 3 * r * r - k + (long) (d * 2); }
    public double ratio(float f) { return r * 1.5 - f; }
    public boolean big(int n) { return r * 2 > n; }
    public int[] cells(int n) { return new int[] { n + 1, (int) r, 7 }; }
    public String name() { return "circ" + r; }
    public void touch(int[] box) { box[0] -= (int) r; }
  }

  static final class Tri implements Shape {
    public long area(long k, double d) { throw new IllegalStateException("tri " + k); }
    public double ratio(float f) { return f; }
    public boolean big(int n) { return false; }
    public int[] cells(int n) { return new int[0]; }
    public String name() { return "tri"; }
    public void touch(int[] box) { }
  }

  static class Base {
    int v;
    long w;
    Base(int v) { this.v = v; }
    int get() { return v; }
    void set(int x) { v = x; w += x; }
    int twice() { return get() + get(); }
  }

  static long total(Shape s, long k) {
    long t = s.area(k, 1.5);
    t += (long) s.ratio(2f);
    if (s.big(10)) t += 1;
    t += s.cells(3).length;
    t += s.name().length();
    int[] box = new int[1];
    s.touch(box);
    return t + box[0];
  }

  static int via(Base b) { return b.twice(); }

  static void run(String label, Shape[] shapes, int rounds) {
    long sum = 0;
    for (int i = 0; i < rounds; i++) sum += total(shapes[i % shapes.length], i);
    System.out.println(label + " " + sum);
  }

  public static void main(String[] args) {
    Shape[] sq = { new Sq(4) };
    Shape[] mix = { new Sq(4), new Circ(3), new Sq(5), new Circ(2) };
    run("warm", sq, 3000);
    run("miss", mix, 3000);
    run("again", sq, 3000);

    Shape[] withTri = { new Sq(2), new Tri() };
    try {
      run("tri", withTri, 3000);
    } catch (IllegalStateException e) {
      System.out.println(e.getMessage());
    }

    int nulls = 0;
    for (int i = 0; i < 2000; i++) {
      try {
        total(i % 100 == 99 ? null : sq[0], i);
      } catch (NullPointerException e) {
        nulls++;
      }
    }
    System.out.println("npe " + nulls);

    Base b = new Base(5);
    long t = 0;
    for (int i = 0; i < 4000; i++) {
      b.set(i);
      t += via(b);
    }
    System.out.println(t + " " + b.w);
    int caught = 0;
    for (int i = 0; i < 1000; i++) {
      try {
        via(i % 10 == 9 ? null : b);
      } catch (NullPointerException e) {
        caught++;
      }
    }
    System.out.println("npe2 " + caught);
    IntSupplier sup = b::get;
    long s2 = 0;
    for (int i = 0; i < 2000; i++) s2 += sup.getAsInt();
    System.out.println(s2);
  }
}
