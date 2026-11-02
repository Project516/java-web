import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

// Writes past the file size limit (ulimit -f), so the host refuses them. HotSpot
// reports that from write(); java-web, which buffers, from close, sync or force.
public class Full {
  public static void main(String[] args) throws Exception {
    Path p = Path.of(args[0]);
    try {
      try (var out = new FileOutputStream(p.toFile())) {
        out.write(new byte[8192]);
      }
      System.out.println("closed");
    } catch (IOException e) {
      System.out.println("close: " + e.getMessage());
    }
    try (var out = new FileOutputStream(p.toFile())) {
      out.write(new byte[8192]);
      out.getFD().sync();
      System.out.println("synced");
    } catch (IOException e) {
      System.out.println("sync: " + e.getMessage());
    }
    try (var ch = FileChannel.open(p, StandardOpenOption.WRITE)) {
      ByteBuffer b = ByteBuffer.allocate(8192);
      while (b.hasRemaining()) ch.write(b);
      ch.force(true);
      System.out.println("forced");
    } catch (IOException e) {
      System.out.println("force: " + e.getMessage());
    }
  }
}
