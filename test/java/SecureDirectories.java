import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.NotDirectoryException;
import java.nio.file.Path;
import java.nio.file.SecureDirectoryStream;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributeView;
import java.util.Comparator;
import java.util.Set;
import java.util.TreeSet;

public class SecureDirectories {
    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("secure");
        Path other = Files.createTempDirectory("secure");
        try {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
                var secure = (SecureDirectoryStream<Path>) stream;
                try (SeekableByteChannel ch = secure.newByteChannel(Path.of("a"),
                        Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE))) {
                    ch.write(ByteBuffer.wrap("hello".getBytes()));
                }
                System.out.println("created " + Files.readString(dir.resolve("a")));
                System.out.println("is file " + secure.getFileAttributeView(Path.of("a"), BasicFileAttributeView.class)
                        .readAttributes().isRegularFile());
                try (SecureDirectoryStream<Path> sub = secure.newDirectoryStream(Path.of("."))) {
                    var names = new TreeSet<String>();
                    for (Path p : sub) names.add(p.getFileName().toString());
                    System.out.println("listed " + names);
                }
                try (var notDir = secure.newDirectoryStream(Path.of("a"))) {
                    System.out.println("opened a file as a directory");
                } catch (NotDirectoryException e) {
                    System.out.println("not a directory");
                }
                try (DirectoryStream<Path> target = Files.newDirectoryStream(other)) {
                    secure.move(Path.of("a"), (SecureDirectoryStream<Path>) target, Path.of("b"));
                }
                System.out.println("moved " + Files.exists(dir.resolve("a")) + " " + Files.exists(other.resolve("b")));
                try {
                    secure.deleteDirectory(Path.of("missing-dir"));
                } catch (java.nio.file.NoSuchFileException e) {
                    System.out.println("no such file");
                }
                for (String name : new String[] {".", ".."}) {
                    try {
                        secure.deleteDirectory(Path.of(name));
                        System.out.println("deleted directory " + name);
                    } catch (IOException e) {
                        System.out.println("delete directory " + name + " " + e.getClass().getSimpleName());
                    }
                    try {
                        secure.deleteFile(Path.of(name));
                        System.out.println("deleted file " + name);
                    } catch (IOException e) {
                        System.out.println("delete file " + name + " " + e.getClass().getSimpleName());
                    }
                }
                System.out.println("directory kept " + Files.isDirectory(dir));
            }
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(other)) {
                var secure = (SecureDirectoryStream<Path>) stream;
                secure.deleteFile(Path.of("b"));
                System.out.println("deleted " + Files.exists(other.resolve("b")));
            }
            Path gone = Files.createTempDirectory("secure");
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(gone)) {
                var secure = (SecureDirectoryStream<Path>) stream;
                Files.delete(gone);
                try (var ch = secure.newByteChannel(Path.of("late"),
                        Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE))) {
                    System.out.println("created in a deleted directory");
                } catch (IOException e) {
                    System.out.println("deleted directory " + e.getClass().getSimpleName());
                }
                try {
                    secure.deleteFile(Path.of("late"));
                } catch (IOException e) {
                    System.out.println("delete in deleted directory " + e.getClass().getSimpleName());
                }
            }
            try {
                Files.newDirectoryStream(other.resolve("nothing"));
            } catch (java.nio.file.NoSuchFileException e) {
                System.out.println("missing directory");
            }
        } finally {
            for (Path d : new Path[] {dir, other}) {
                try (var s = Files.walk(d)) {
                    s.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
                }
            }
        }
    }
}
