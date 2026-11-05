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
