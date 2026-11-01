// Run with -Xmx17m: an array bigger than the heap fails, a small one does not.
// With an argument, prints the heap's size.
public class Heap {
  public static void main(String[] args) {
    try {
      int[] big = new int[8 << 20];
      System.out.println("allocated " + big.length);
    } catch (OutOfMemoryError e) {
      System.out.println("OutOfMemoryError: " + e.getMessage());
    }
    System.out.println("small " + new int[1 << 20].length);
    Runtime rt = Runtime.getRuntime();
    System.out.println("free <= total <= max " + (rt.freeMemory() <= rt.totalMemory() && rt.totalMemory() <= rt.maxMemory()));
    var usage = java.lang.management.ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
    System.out.println("heap usage within max " + (usage.getCommitted() <= usage.getMax() && usage.getMax() == rt.maxMemory()));
    // the heap's exact size depends on the platform's rounding
    long max = rt.maxMemory();
    System.out.println(args.length > 0 ? "max " + max : "max under 32 MB " + (max <= 32 << 20));
  }
}
