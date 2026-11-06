import java.nio.file.*;
import java.nio.file.attribute.*;

// attribute calls and opening a file do not read it, so they leave its access time alone
public class AccessTimeKept {
    public static void main(String[] args) throws Exception {
        Path dir = Files.createTempDirectory("atime");
        Path file = Files.createFile(dir.resolve("foo"));
        try {
            BasicFileAttributes first = Files.readAttributes(file, BasicFileAttributes.class);
            FileTime mod = first.lastModifiedTime();
            Files.setAttribute(file, "basic:lastModifiedTime", FileTime.fromMillis(0L));
            Files.setAttribute(file, "lastModifiedTime", mod);
            BasicFileAttributes last = Files.readAttributes(file, BasicFileAttributes.class);
            System.out.println(last.lastAccessTime().equals(first.lastAccessTime()));
            System.out.println(last.lastModifiedTime().equals(mod));
        } finally {
            Files.delete(file);
            Files.delete(dir);
        }
    }
}
