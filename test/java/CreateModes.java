import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;

import static java.nio.file.StandardOpenOption.*;

public class CreateModes {
    static void show(String what, Path p) throws IOException {
        System.out.println(what + " " + PosixFilePermissions.toString(Files.getPosixFilePermissions(p)));
    }

    static FileAttribute<Set<PosixFilePermission>> perms(String s) {
        return PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString(s));
    }

    public static void main(String[] args) throws IOException {
        Path dir = Files.createTempDirectory("modes");
        try {
            Path a = Files.createFile(dir.resolve("a"), perms("rw-------"));
            show("createFile 600", a);
            Path b = Files.createFile(dir.resolve("b"), perms("rwxr-x---"));
            show("createFile 750", b);
            Path c = Files.createFile(dir.resolve("c"));
            show("createFile default", c);
            Path d = Files.createDirectory(dir.resolve("d"), perms("rwx------"));
            show("createDirectory 700", d);
            Path t = Files.createTempFile(dir, "t", ".tmp");
            show("createTempFile", t);
            Path td = Files.createTempDirectory(dir, "td");
            show("createTempDirectory", td);
            // a read-only file can still be written through the descriptor that created it
            Path f = dir.resolve("f");
            try (FileChannel ch = FileChannel.open(f, Set.of(CREATE_NEW, WRITE), perms("r--r--r--"))) {
                ch.write(ByteBuffer.wrap("data".getBytes()));
            }
            show("channel 444", f);
            System.out.println(Files.readString(f));
            Files.setPosixFilePermissions(f, PosixFilePermissions.fromString("rw-------"));
            Files.delete(f);
        } finally {
            try (var s = Files.walk(dir)) {
                s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            }
        }
    }
}
