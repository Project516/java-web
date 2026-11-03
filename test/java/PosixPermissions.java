import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;

public class PosixPermissions {
    public static void main(String[] args) throws Exception {
        Path file = Files.createTempFile("java-web-mode", ".tmp");
        try {
            Set<PosixFilePermission> permissions = PosixFilePermissions.fromString("rwxr-----");
            Files.setPosixFilePermissions(file, permissions);
            System.out.println(PosixFilePermissions.toString(Files.getPosixFilePermissions(file)));
            try {
                Files.setPosixFilePermissions(file.resolveSibling("missing"), permissions);
                System.out.println("missing path accepted");
            } catch (NoSuchFileException e) {
                System.out.println("missing path rejected");
            }
        } finally {
            Files.deleteIfExists(file);
        }
    }
}
