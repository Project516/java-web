import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.util.Arrays;
import java.util.Comparator;

// Directory create, list and delete, and file copies, through java.io and java.nio.file.
public class FileOps {
  public static void main(String[] args) throws Exception {
    Path root = Files.createTempDirectory("fileops");
    File dir = root.resolve("a/b").toFile();
    System.out.println("mkdirs " + dir.mkdirs() + " " + dir.isDirectory());
    Files.writeString(root.resolve("a/b/x.txt"), "hello");
    Files.writeString(root.resolve("a/y.txt"), "world");
    String[] names = root.resolve("a").toFile().list();
    Arrays.sort(names);
    System.out.println("list " + Arrays.toString(names));
    Path copy = Files.copy(root.resolve("a/y.txt"), root.resolve("a/z.txt"));
    System.out.println("copy " + Files.readString(copy));
    try {
      Files.copy(root.resolve("a/y.txt"), copy);
    } catch (FileAlreadyExistsException e) {
      System.out.println("copy over existing: FileAlreadyExistsException");
    }
    Files.writeString(root.resolve("a/empty"), "");
    Files.copy(root.resolve("a/empty"), copy, StandardCopyOption.REPLACE_EXISTING);
    System.out.println("copy empty " + Files.size(copy));
    // modification times, through java.io and java.nio.file
    File y = root.resolve("a/y.txt").toFile();
    System.out.println("setLastModified " + y.setLastModified(1_000_000_000_000L) + " " + y.lastModified());
    Files.setLastModifiedTime(copy, FileTime.fromMillis(1_500_000_000_123L));
    System.out.println("setLastModifiedTime " + Files.getLastModifiedTime(copy).toMillis());
    try (var out = new FileOutputStream(copy.toFile(), true)) {
      out.write('!');
      Files.setLastModifiedTime(copy, FileTime.fromMillis(1_600_000_000_000L));
    }
    System.out.println("timed while open " + Files.getLastModifiedTime(copy).toMillis() + " " + Files.size(copy));
    System.out.println("missing " + root.resolve("nope").toFile().setLastModified(1));
    // descriptors open on one file see each other's writes
    try (var out = new FileOutputStream(copy.toFile()); var in = new FileInputStream(copy.toFile())) {
      out.write("shared".getBytes());
      System.out.println("read while open " + new String(in.readAllBytes()));
      try (var again = new FileOutputStream(copy.toFile())) {
        System.out.println("after truncate " + in.available() + " " + Files.size(copy));
      }
    }
    Files.delete(copy);
    Files.delete(root.resolve("a/empty"));
    System.out.println("delete non-empty " + root.resolve("a").toFile().delete());
    try {
      Files.delete(root.resolve("a"));
    } catch (DirectoryNotEmptyException e) {
      System.out.println("nio non-empty: DirectoryNotEmptyException");
    }
    System.out.println("delete file " + root.resolve("a/b/x.txt").toFile().delete());
    System.out.println("delete empty dir " + dir.delete() + " " + dir.exists());
    try (var walk = Files.walk(root)) {
      walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
    }
    System.out.println("tree gone " + !Files.exists(root));
  }
}
