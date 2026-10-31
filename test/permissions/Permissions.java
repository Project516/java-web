import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

// Writes the host refuses: args are a read-only file and a read-only directory.
public class Permissions {
  public static void main(String[] args) throws Exception {
    Path file = Path.of(args[0]), dir = Path.of(args[1]);
    try (var out = new FileOutputStream(file.toFile())) {
      System.out.println("opened");
    } catch (IOException e) {
      System.out.println(e.getMessage().replace(args[0], "FILE"));
    }
    try {
      Files.writeString(file, "x");
    } catch (IOException e) {
      System.out.println(e.getClass().getName());
    }
    System.out.println(file.toFile().canWrite() + " " + Files.isWritable(file) + " " + Files.isReadable(file));
    try {
      new File(dir.toFile(), "new.txt").createNewFile();
    } catch (IOException e) {
      System.out.println(e.getMessage());
    }
    try {
      Files.writeString(dir.resolve("new.txt"), "x");
    } catch (IOException e) {
      System.out.println(e.getClass().getName());
    }
    System.out.println(Files.isWritable(dir) + " " + Files.exists(dir.resolve("new.txt")));
  }
}
