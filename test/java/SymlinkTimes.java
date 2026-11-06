import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributeView;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.time.Instant;

public class SymlinkTimes {
    static BasicFileAttributes read(Path p, LinkOption... o) throws IOException {
        return Files.readAttributes(p, BasicFileAttributes.class, o);
    }

    static void show(String label, BasicFileAttributes a) {
        System.out.println(label + " mod " + a.lastModifiedTime() + " acc " + a.lastAccessTime());
    }

    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("symlink-times");
        try {
            Path file = dir.resolve("file");
            Path link = dir.resolve("link");
            Files.createFile(file);
            Files.createSymbolicLink(link, file);
            BasicFileAttributes before = read(file);

            FileTime mod = FileTime.fromMillis(1_000_060_000L);
            FileTime acc = FileTime.fromMillis(1_000_120_000L);
            var linkView = Files.getFileAttributeView(link, BasicFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
            linkView.setTimes(mod, acc, null);
            show("link", read(link, LinkOption.NOFOLLOW_LINKS));
            BasicFileAttributes after = read(file);
            System.out.println("target unchanged " + after.lastModifiedTime().equals(before.lastModifiedTime())
                + " " + after.lastAccessTime().equals(before.lastAccessTime()));

            // each time alone keeps the other
            linkView.setTimes(null, FileTime.fromMillis(2_000_000_000L), null);
            show("link acc only", read(link, LinkOption.NOFOLLOW_LINKS));
            linkView.setTimes(FileTime.fromMillis(3_000_000_000L), null, null);
            show("link mod only", read(link, LinkOption.NOFOLLOW_LINKS));

            // the file itself, with nanoseconds
            var view = Files.getFileAttributeView(file, BasicFileAttributeView.class);
            view.setTimes(FileTime.from(Instant.ofEpochSecond(1_500_000_000L, 123_456_789)),
                FileTime.from(Instant.ofEpochSecond(1_600_000_000L, 987_654_321)), null);
            show("file", read(file));
            show("link", read(link, LinkOption.NOFOLLOW_LINKS));
        } finally {
            Files.deleteIfExists(dir.resolve("link"));
            Files.deleteIfExists(dir.resolve("file"));
            Files.deleteIfExists(dir);
        }
    }
}
