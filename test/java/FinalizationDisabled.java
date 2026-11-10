// java: --finalization=disabled
// With finalization disabled there is no Finalizer thread and finalize() is not called.
public class FinalizationDisabled {
  static volatile boolean finalized;

  @Override
  protected void finalize() {
    finalized = true;
  }

  static void make() {
    new FinalizationDisabled();
  }

  public static void main(String[] args) throws Exception {
    make();
    for (int i = 0; i < 20; i++) {
      System.gc();
      System.runFinalization();
      Thread.sleep(10);
    }
    boolean thread = false;
    for (Thread t : Thread.getAllStackTraces().keySet()) if (t.getName().equals("Finalizer")) thread = true;
    System.out.println("finalizer thread " + thread);
    System.out.println("finalized " + finalized);
  }
}
