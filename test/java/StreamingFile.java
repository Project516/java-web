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
  }
}
