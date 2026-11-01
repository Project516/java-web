import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;

// Writes to stdout after its reader has gone, as under `| head -1`.
public class Pipe {
  public static void main(String[] args) throws Exception {
    for (int i = 0; i < 20000; i++) System.out.println("line " + i);
    // java-web learns of the closed pipe on node's next event loop turn
    Thread.sleep(200);
    System.out.println("after");
    System.err.println("checkError " + System.out.checkError());
    try (var raw = new FileOutputStream(FileDescriptor.out)) {
      raw.write('x');
      System.err.println("raw write ok");
    } catch (IOException e) {
      System.err.println("raw " + e.getMessage());
    }
  }
}
