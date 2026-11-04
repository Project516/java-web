import java.io.DataInputStream;
import java.nio.file.Files;
import java.nio.file.Path;

void main(String[] args) throws Exception {
  Path src = Path.of(args[0]);
  Path diff = src.resolve("jdk.jlink/jdk/tools/jlink/internal/runtimelink/diff_java.base");
  try (var in = new DataInputStream(Files.newInputStream(diff))) {
    in.readInt();
    for (int n = in.readInt(); n > 0; n--) {
      short kind = in.readShort();
      String name = new String(in.readNBytes(in.readInt()));
      byte[] original = in.readNBytes(in.readInt());
      Path file = src.resolve(name.substring(1));
      if (kind == 1) Files.deleteIfExists(file);
      else {
        Files.createDirectories(file.getParent());
        Files.write(file, original);
      }
    }
  }
}
