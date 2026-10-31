import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.UUID;

// Character devices stream instead of being read whole, and allocations past
// the heap fail without taking the machine down.
public class Devices {
  public static void main(String[] args) throws Exception {
    try (FileInputStream in = new FileInputStream("/dev/urandom")) {
      System.out.println("urandom " + in.readNBytes(1 << 20).length);
    }
    try (FileInputStream in = new FileInputStream("/dev/zero")) {
      byte[] b = in.readNBytes(4096);
      int sum = 0;
      for (byte x : b) sum += x;
      System.out.println("zero " + b.length + " " + sum);
    }
    try (FileInputStream in = new FileInputStream("/dev/null")) {
      System.out.println("null " + in.read());
    }
    try (FileOutputStream out = new FileOutputStream("/dev/null")) {
      out.write(new byte[1 << 16]);
      System.out.println("null write ok");
    }
    File f = new File("/dev/urandom");
    System.out.println(f.exists() + " " + f.isFile() + " " + f.isDirectory() + " " + Files.isRegularFile(Path.of("/dev/urandom")));
    System.out.println("secure " + (new SecureRandom().nextInt(10) < 10));
    System.out.println("uuid " + UUID.randomUUID().toString().length());

    try {
      long[] huge = new long[1_000_000_000];
      System.out.println("allocated " + huge.length);
    } catch (OutOfMemoryError e) {
      System.out.println("OutOfMemoryError: " + e.getMessage());
    }
  }
}
