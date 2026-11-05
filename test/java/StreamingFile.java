import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;

public class StreamingFile {
  public static void main(String[] args) throws Exception {
    Path path = Files.createTempFile("streaming-file", ".bin");
    try (RandomAccessFile first = new RandomAccessFile(path.toFile(), "rw");
         RandomAccessFile second = new RandomAccessFile(path.toFile(), "rw")) {
      byte[] block = new byte[1024 * 1024];
      for (int i = 0; i < block.length; i++) block[i] = (byte) i;
      for (int i = 0; i < 16; i++) first.write(block);
      first.seek(20L * 1024 * 1024 + 3);
      first.write(123);
      System.out.println(second.length());
      second.seek(19L * 1024 * 1024);
      System.out.println(second.read() + " " + second.read());
      FileChannel channel = second.getChannel();
      ByteBuffer b = ByteBuffer.allocate(4);
      channel.read(b, 20L * 1024 * 1024);
      System.out.println(b.get(0) + " " + b.get(3));
      channel.truncate(1024 * 1024 + 1);
      first.setLength(2 * 1024 * 1024);
      first.seek(1024 * 1024);
      System.out.println(first.read() + " " + first.read() + " " + second.length());
    } finally {
      Files.deleteIfExists(path);
    }
    Path big = Files.createTempFile("streaming-file", ".bin");
    try {
      try (RandomAccessFile out = new RandomAccessFile(big.toFile(), "rw")) {
        out.setLength(6L << 20);
        out.seek((6L << 20) - 1);
        out.write(7);
      }
      try (RandomAccessFile again = new RandomAccessFile(big.toFile(), "rw")) {
        again.seek((6L << 20) - 1);
        System.out.println(again.read() + " " + again.length());
        again.write(9);
        again.setLength(1000);
        System.out.println(again.length() + " " + Files.size(big));
      }
      System.out.println(Files.size(big));
      try (RandomAccessFile ro = new RandomAccessFile(big.toFile(), "r")) {
        ro.setLength(0);
      } catch (java.io.IOException e) {
        System.out.println(e.getMessage());
      }
      Files.write(big, new byte[5 << 20]);
      try (RandomAccessFile reader = new RandomAccessFile(big.toFile(), "r");
           RandomAccessFile writer = new RandomAccessFile(big.toFile(), "rw")) {
        writer.seek(1 << 20);
        writer.write(42);
        reader.seek(1 << 20);
        System.out.println(reader.read() + " " + reader.length());
      }
      try (var out = new java.io.FileOutputStream(big.toFile(), true);
           var in = new java.io.FileInputStream(big.toFile())) {
        out.write(7);
        System.out.println(in.skip(5 << 20) + " " + in.read() + " " + in.read());
      }
      Path moved = big.resolveSibling(big.getFileName() + ".moved");
      try (var out = new java.io.FileOutputStream(big.toFile())) {
        out.write(new byte[1 << 20]);
        Files.move(big, moved);
        for (int i = 0; i < 5; i++) out.write(new byte[1 << 20]);
      }
      System.out.println(Files.exists(big) + " " + Files.size(moved));
      Files.delete(moved);
      Files.write(big, new byte[1000]);
      try (RandomAccessFile ro = new RandomAccessFile(big.toFile(), "r")) {
        ro.write(1);
        System.out.println("wrote");
      } catch (java.io.IOException e) {
        System.out.println(e.getMessage() + " " + Files.size(big));
      }
    } finally {
      Files.deleteIfExists(big);
    }
  }
}
