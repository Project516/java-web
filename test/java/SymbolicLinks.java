import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.stream.Collectors;

public class SymbolicLinks {
    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("links").toRealPath();
        try {
            Path file = Files.writeString(dir.resolve("file"), "data");
            Path sub = Files.createDirectory(dir.resolve("sub"));
            Path toFile = Files.createSymbolicLink(dir.resolve("toFile"), Path.of("file"));
            Path toDir = Files.createSymbolicLink(dir.resolve("toDir"), sub);
            Path dangling = Files.createSymbolicLink(dir.resolve("dangling"), Path.of("missing"));

            System.out.println("readlink " + Files.readSymbolicLink(toFile) + " " + (Files.readSymbolicLink(toDir).equals(sub)));
            System.out.println("isSymbolicLink " + Files.isSymbolicLink(toFile) + " " + Files.isSymbolicLink(file));
            System.out.println("read through link " + Files.readString(toFile));
            System.out.println("exists " + Files.exists(toFile) + " " + Files.exists(dangling) + " " + Files.exists(dangling, LinkOption.NOFOLLOW_LINKS));
            System.out.println("isDirectory " + Files.isDirectory(toDir) + " " + Files.isDirectory(toDir, LinkOption.NOFOLLOW_LINKS));
            System.out.println("size nofollow " + Files.readAttributes(toFile, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS).size());
            System.out.println("toRealPath " + dir.relativize(toFile.toRealPath()) + " " + dir.relativize(toDir.toRealPath()));
            System.out.println("canonical " + new File(toFile.toString()).getCanonicalPath().equals(file.toString()));
            System.out.println("canonical missing " + new File(dir + "/toDir/new").getCanonicalPath().equals(sub + "/new"));

            Files.writeString(toDir.resolve("inner"), "x");
            System.out.println("list through link " + Files.list(toDir).map(p -> p.getFileName().toString()).collect(Collectors.toList()));

            try {
                Files.createSymbolicLink(toFile, file);
            } catch (java.nio.file.FileAlreadyExistsException e) {
                System.out.println("exists error");
            }
            try {
                Files.readSymbolicLink(file);
            } catch (java.nio.file.NotLinkException e) {
                System.out.println("not a link");
            }

            Path copy = Files.copy(toFile, dir.resolve("copy"), LinkOption.NOFOLLOW_LINKS);
            System.out.println("copy of link " + Files.isSymbolicLink(copy));
            Path moved = Files.move(toDir, dir.resolve("moved"), StandardCopyOption.ATOMIC_MOVE);
            System.out.println("moved link " + Files.isSymbolicLink(moved));

            Files.delete(moved);
            Files.delete(toFile);
            System.out.println("target kept " + Files.exists(sub) + " " + Files.exists(file));
            System.out.println("deleting dangling " + Files.deleteIfExists(dangling));
            try {
                Files.delete(dangling);
            } catch (NoSuchFileException e) {
                System.out.println("already gone");
            }
        } finally {
            try (var s = Files.walk(dir)) {
                s.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            }
        }
    }
}
