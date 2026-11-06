import java.nio.file.*;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;

// a host process changes a watched directory, then the program itself does
public class WatchHostChanges {
    static void collect(java.nio.file.WatchService ws, TreeSet<String> seen, long quietMs) throws Exception {
        for (WatchKey key; (key = ws.poll(quietMs, TimeUnit.MILLISECONDS)) != null; key.reset()) {
            for (WatchEvent<?> e : key.pollEvents()) seen.add(e.kind().name() + " " + e.context());
        }
    }

    public static void main(String[] args) throws Exception {
        Path dir = Files.createTempDirectory("watch-host");
        try (java.nio.file.WatchService ws = FileSystems.getDefault().newWatchService()) {
            dir.register(ws, StandardWatchEventKinds.ENTRY_CREATE, StandardWatchEventKinds.ENTRY_MODIFY,
                StandardWatchEventKinds.ENTRY_DELETE);
            String d = dir.toString();
            Process p = new ProcessBuilder("/bin/sh", "-c",
                "touch '" + d + "/x'; sleep 0.3; echo hi >> '" + d + "/y'; sleep 0.3; rm '" + d + "/x'").start();
            p.waitFor();
            TreeSet<String> host = new TreeSet<>();
            collect(ws, host, 1500);
            System.out.println("host " + host);

            Files.writeString(dir.resolve("z"), "z");
            Files.delete(dir.resolve("y"));
            TreeSet<String> own = new TreeSet<>();
            collect(ws, own, 1500);
            System.out.println("own " + own);
        } finally {
            try (var list = Files.list(dir)) {
                for (Path f : list.toList()) Files.deleteIfExists(f);
            }
            Files.deleteIfExists(dir);
        }
    }
}
