// Garbage with a finalizer on a reference cycle does not pile up.
public class FinalizerCycles {
  static class Child {
    Object parent;
    byte[] pad = new byte[200];
  }

  static class Node {
    Child child = new Child();
    Node() {
      child.parent = this;
    }

    @Override
    protected void finalize() {}
  }

  static long used() {
    Runtime r = Runtime.getRuntime();
    return r.totalMemory() - r.freeMemory();
  }

  public static void main(String[] args) throws Exception {
    long first = 0, last = 0;
    for (int round = 0; round < 5; round++) {
      for (int i = 0; i < 30000; i++) new Node();
      for (int k = 0; k < 5; k++) {
        System.gc();
        System.runFinalization();
        Thread.sleep(20);
      }
      if (round == 1) first = used();
      last = used();
    }
    System.out.println("flat " + (last - first < (16 << 20)));
  }
}
