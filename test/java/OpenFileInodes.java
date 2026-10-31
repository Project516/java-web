import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.nio.file.Path;

// A file open for writing follows its inode: renames move it, an unlink leaves it nameless.
public class OpenFileInodes {
  public static void main(String[] args) throws Exception {
    Path dir = Files.createTempDirectory("inodes");
    File a = dir.resolve("a").toFile();
    File b = dir.resolve("b").toFile();
    try (var out = new FileOutputStream(a)) {
      out.write(new byte[10]);
      System.out.println("rename " + a.renameTo(b));
      out.write(new byte[20]);
      out.flush();
      System.out.println("while open a " + a.exists() + " b " + b.length());
    }
    System.out.println("closed a " + a.exists() + " b " + b.length());

    try (var out = new FileOutputStream(b)) {
      out.write(new byte[5]);
      Files.move(b.toPath(), a.toPath());
      out.write(new byte[5]);
    }
    System.out.println("nio move a " + a.length() + " b " + b.exists());

    File sub = dir.resolve("sub").toFile();
    File moved = dir.resolve("moved").toFile();
    sub.mkdir();
    try (var out = new FileOutputStream(new File(sub, "f"))) {
      out.write(1);
      System.out.println("dir rename " + sub.renameTo(moved));
      out.write(2);
    }
    System.out.println("in moved dir " + new File(moved, "f").length() + " old " + sub.exists());

    try (var raf = new RandomAccessFile(a, "rw")) {
      raf.write(new byte[3]);
      System.out.println("delete " + a.delete());
      raf.write(new byte[3]);
      System.out.println("unlinked length " + raf.length());
      Files.writeString(a.toPath(), "fresh");
    }
    System.out.println("after close " + Files.readString(a.toPath()));

    try (var out = new FileOutputStream(b)) {
      out.write(7);
      Files.delete(b.toPath());
      out.write(8);
    }
    System.out.println("nio delete " + b.exists());

    Files.writeString(a.toPath(), "source");
    try (var out = new FileOutputStream(b)) {
      out.write(new byte[9]);
      Files.move(a.toPath(), b.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      out.write(new byte[9]);
    }
    System.out.println("replaced while open " + Files.readString(b.toPath()) + " a " + a.exists());
    b.delete();

    new File(moved, "f").delete();
    for (File f : new File[] {moved, a, dir.toFile()}) f.delete();
  }
}
