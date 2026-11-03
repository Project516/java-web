// java: --add-opens java.base/sun.nio.fs=ALL-UNNAMED --add-opens java.base/java.io=ALL-UNNAMED
import java.io.FileDescriptor;
import java.io.RandomAccessFile;
import java.lang.reflect.InvocationTargetException;
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
            var fchmod = Class.forName("sun.nio.fs.UnixNativeDispatcher").getDeclaredMethod("fchmod", int.class, int.class);
            fchmod.setAccessible(true);
            var descriptor = FileDescriptor.class.getDeclaredField("fd");
            descriptor.setAccessible(true);
            try (var open = new RandomAccessFile(file.toFile(), "rw")) {
                fchmod.invoke(null, descriptor.getInt(open.getFD()), 0600);
                System.out.println("descriptor " + PosixFilePermissions.toString(Files.getPosixFilePermissions(file)));
            }
            try {
                fchmod.invoke(null, -1, 0600);
            } catch (InvocationTargetException e) {
                System.out.println("invalid descriptor " + e.getCause().getClass().getName());
            }
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
