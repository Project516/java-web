// Run with -Xmx16m: an array bigger than the heap fails, a small one does not.
public class Heap {
  public static void main(String[] args) {
    try {
      int[] big = new int[8 << 20];
      System.out.println("allocated " + big.length);
    } catch (OutOfMemoryError e) {
      System.out.println("OutOfMemoryError: " + e.getMessage());
    }
    System.out.println("small " + new int[1 << 20].length);
    System.out.println("max under 32 MB " + (Runtime.getRuntime().maxMemory() <= 32 << 20));
  }
}
