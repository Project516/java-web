import java.io.RandomAccessFile;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import sun.misc.Unsafe;
import java.lang.reflect.Field;

public class MappedFile {
    public static void main(String[] args) throws Exception {
        Path path = Files.createTempFile("mapped", ".bin");
        try {
            try (RandomAccessFile file = new RandomAccessFile(path.toFile(), "rw")) {
                file.setLength(4 * 1024 * 1024);
                MappedByteBuffer map = file.getChannel().map(FileChannel.MapMode.READ_WRITE, 0, file.length());
                map.put(0, (byte) 17);
                map.put(2 * 1024 * 1024, (byte) 42);
                map.force();
                map.put(4 * 1024 * 1024 - 1, (byte) 99);
                Field field = Unsafe.class.getDeclaredField("theUnsafe");
                field.setAccessible(true);
                ((Unsafe) field.get(null)).invokeCleaner(map);
                file.seek(0);
                System.out.println(file.read());
                file.seek(2 * 1024 * 1024);
                System.out.println(file.read());
                file.seek(file.length() - 1);
                System.out.println(file.read());
            }
        } finally {
            Files.delete(path);
        }
    }
}
