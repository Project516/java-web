import java.net.URI;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

public class ImageStrings {
  public static void main(String[] args) throws Exception {
    FileSystem jrt = FileSystems.getFileSystem(URI.create("jrt:/"));
    try (Stream<Path> s = Files.list(jrt.getPath("/modules/java.base/java/lang/invoke"))) {
      s.map(Path::toString).sorted().forEach(System.out::println);
    }
    try (Stream<Path> s = Files.walk(jrt.getPath("/modules/java.compiler"))) {
      System.out.println(s.count());
    }
    System.out.println(Files.readAllBytes(jrt.getPath("/modules/java.base/java/lang/Object.class")).length);
  }
}
