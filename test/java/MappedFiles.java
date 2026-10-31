import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;

// Memory-mapped files, attribute-preserving copies and file stores.
public class MappedFiles {
    public static void main(String[] args) throws Exception {
        Path dir = Files.createTempDirectory("mapped");
        Path file = dir.resolve("data");
        Files.writeString(file, "0123456789");
        try (FileChannel ch = FileChannel.open(file, StandardOpenOption.READ, StandardOpenOption.WRITE)) {
            MappedByteBuffer map = ch.map(FileChannel.MapMode.READ_WRITE, 2, 4);
            map.load();
            System.out.println("loaded " + map.isLoaded() + " " + (char) map.get(0));
            map.put(0, (byte) 'a').put(1, (byte) 'b');
            map.force();
            System.out.println("after force " + Files.readString(file));
            MappedByteBuffer ro = ch.map(FileChannel.MapMode.READ_ONLY, 0, 3);
            System.out.println("read only " + (char) ro.get(2));
        }
        Path copy = Files.copy(file, dir.resolve("copy"), StandardCopyOption.COPY_ATTRIBUTES);
        System.out.println("copy " + Files.readString(copy));
        System.out.println("store " + Files.getFileStore(file).isReadOnly());
        Files.delete(copy);
        Files.delete(file);
        Files.delete(dir);
    }
}
