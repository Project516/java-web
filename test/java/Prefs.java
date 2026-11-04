import java.nio.file.*;
import java.util.Comparator;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.prefs.Preferences;

// User preferences are stored in files under java.util.prefs.userRoot, which
// FileSystemPreferences locks and chmods as on HotSpot.
public class Prefs {
  public static void main(String[] args) throws Exception {
    // its log lines carry the time; HotSpot logs the same ones
    Logger.getLogger("java.util.prefs").setLevel(Level.OFF);
    // a fresh root, not the user's own preferences
    Path root = Files.createTempDirectory("prefs");
    System.setProperty("java.util.prefs.userRoot", root.toString());
    Preferences node = Preferences.userRoot().node("java-web-test");
    try {
      node.put("greeting", "hello");
      node.putInt("count", 3);
      node.flush();
      node.sync();
      System.out.println(node.get("greeting", "?") + " " + node.getInt("count", 0) + " " + String.join(",", node.keys()));
    } finally {
      node.removeNode();
      Preferences.userRoot().flush();
      try (var files = Files.walk(root)) {
        files.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
      }
    }
  }
}
