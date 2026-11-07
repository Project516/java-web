import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

// An open stream keeps its file; a new open through the same link reads the file the link now names.
public class SymlinkTargetReplaced {
  public static void main(String[] args) throws Exception {
    Path dir = Files.createTempDirectory("replaced");
    for (int size : new int[] {10, 5 << 20}) {
      Path target = dir.resolve("target" + size);
      Path link = dir.resolve("link" + size);
      byte[] old = new byte[size];
      old[0] = 1;
      old[1] = 3;
      Files.write(target, old);
      Files.createSymbolicLink(link, target);
      try (InputStream held = new FileInputStream(link.toFile())) {
        System.out.println(size + " held first " + held.read());
        Files.move(target, dir.resolve("moved" + size));
        byte[] fresh = new byte[size + 3];
        fresh[0] = 2;
        fresh[1] = 4;
        Files.write(target, fresh);
        try (InputStream again = new FileInputStream(link.toFile())) {
          int first = again.read();
          System.out.println(size + " reopened first " + first + " length " + Files.size(link));
        }
        System.out.println(size + " held still " + held.read());
      }
      Files.delete(link);
      Files.delete(target);
      Files.delete(dir.resolve("moved" + size));
    }
    Files.delete(dir);
  }
}
