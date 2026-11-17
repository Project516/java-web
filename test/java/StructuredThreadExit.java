// javac: --enable-preview --release 25
// java: --enable-preview
import java.util.concurrent.StructuredTaskScope;

public class StructuredThreadExit {
  static class Worker extends Thread {
    Worker(Runnable task) { super(task); }
    private void exit() { throw new AssertionError("called unrelated private exit"); }
  }

  public static void main(String[] args) throws Exception {
    try (var scope = StructuredTaskScope.open(StructuredTaskScope.Joiner.awaitAll(),
        config -> config.withThreadFactory(Worker::new))) {
      var task = scope.fork(() -> 42);
      scope.join();
      System.out.println(task.get());
    }
  }
}
