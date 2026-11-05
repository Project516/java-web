import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardWatchEventKinds;
import java.nio.file.WatchKey;
import java.util.TreeSet;

public class WatchService {
  private static void collect(java.nio.file.WatchService watch, TreeSet<String> events) throws Exception {
    WatchKey key;
    while ((key = watch.poll()) != null) {
      for (var event : key.pollEvents()) {
        if (event.kind() != StandardWatchEventKinds.OVERFLOW)
          events.add(event.kind().name() + " " + event.context());
      }
      key.reset();
    }
  }

  public static void main(String[] args) throws Exception {
    Path dir = Files.createTempDirectory(Path.of("."), "watch");
    Path file = dir.resolve("item");
    TreeSet<String> events = new TreeSet<>();
    try (java.nio.file.WatchService watch = dir.getFileSystem().newWatchService()) {
      dir.register(watch, StandardWatchEventKinds.ENTRY_CREATE,
          StandardWatchEventKinds.ENTRY_MODIFY, StandardWatchEventKinds.ENTRY_DELETE);
      Files.writeString(file, "first");
      Files.writeString(file, "second");
      Files.delete(file);
      // past 4 MiB the file streams to the host; its writes still report changes
      Path big = dir.resolve("big");
      try (var out = Files.newOutputStream(big)) {
        byte[] block = new byte[1 << 20];
        for (int i = 0; i < 6; i++) out.write(block);
      }
      Files.delete(big);
      Thread.sleep(100);
      collect(watch, events);
    }
    for (String event : events) System.out.println(event);
    Files.delete(dir);
  }
}
