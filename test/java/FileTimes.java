import java.io.File;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.concurrent.TimeUnit;

// A modification time set to the nanosecond reads back the same, as HotSpot
// gives it on a file system that keeps nanoseconds.
public class FileTimes {
  public static void main(String[] args) throws Exception {
    Path dir = Files.createTempDirectory("times");
    Path file = Files.createFile(dir.resolve("f"));
    try {
      long[] times = { 1762300000123456789L, 1762300000999999999L, 1000000000000000001L };
      for (long ns : times) {
        FileTime t = FileTime.from(ns, TimeUnit.NANOSECONDS);
        Files.setLastModifiedTime(file, t);
        FileTime back = Files.readAttributes(file, BasicFileAttributes.class).lastModifiedTime();
        System.out.println(ns + " " + back.equals(t) + " " + back.to(TimeUnit.NANOSECONDS));
      }
      // the directory's time, as java/nio/file/attribute/BasicFileAttributeView/Basic.java copies it
      FileTime dirTime = Files.readAttributes(dir, BasicFileAttributes.class).lastModifiedTime();
      Files.getFileAttributeView(file, BasicFileAttributeView.class).setTimes(dirTime, null, null);
      System.out.println("dir time " + Files.getLastModifiedTime(file).equals(dirTime));
      // the exact time moves with the file
      FileTime exact = FileTime.from(1762300000123456789L, TimeUnit.NANOSECONDS);
      Files.setLastModifiedTime(file, exact);
      Path moved = Files.move(file, dir.resolve("g"));
      System.out.println("moved " + Files.getLastModifiedTime(moved).equals(exact));
      Files.move(moved, file);
      File f = file.toFile();
      f.setLastModified(1762300000123L);
      System.out.println("File " + f.lastModified() + " " + Files.getLastModifiedTime(file).toMillis());
    } finally {
      Files.delete(file);
      Files.delete(dir);
    }
  }
}
