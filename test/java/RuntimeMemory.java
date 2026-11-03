// Runtime's memory figures follow what the program holds.
public class RuntimeMemory {
  static long used(Runtime rt) {
    return rt.totalMemory() - rt.freeMemory();
  }

  public static void main(String[] args) {
    Runtime rt = Runtime.getRuntime();
    long before = used(rt);
    long[] held = new long[8 << 20];
    long after = used(rt);
    System.out.println("used grows by 32 MB holding 64 MB " + (after - before >= 32 << 20));
    System.out.println("free <= total <= max " + (rt.freeMemory() <= rt.totalMemory() && rt.totalMemory() <= rt.maxMemory()));
    System.out.println(held.length);
  }
}
