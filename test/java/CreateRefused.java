import java.io.*;
import java.nio.file.*;

// Creating a file the host refuses reports the host's reason, as HotSpot does.
public class CreateRefused {
  public static void main(String[] args) throws Exception {
    String name = Path.of(System.getProperty("java.io.tmpdir"), "x".repeat(300)).toString();
    try (var out = new FileOutputStream(name)) {
      System.out.println("created");
    } catch (IOException e) {
      System.out.println(e.getClass().getName() + ": " + e.getMessage().replace(name, "<tmp>/<long>"));
    }
    try {
      Files.createFile(Path.of(name));
      System.out.println("created");
    } catch (IOException e) {
      System.out.println(e.getClass().getName() + ": " + e.getMessage().replace(name, "<tmp>/<long>"));
    }
    try {
      Files.newOutputStream(Path.of(name)).close();
      System.out.println("created");
    } catch (IOException e) {
      System.out.println(e.getClass().getName() + ": " + e.getMessage().replace(name, "<tmp>/<long>"));
    }
  }
}
