import java.util.TreeMap;

// System.getenv: the host's environment under Node, as on HotSpot.
public class Environment {
  public static void main(String[] args) {
    System.out.println(new TreeMap<>(System.getenv()).keySet());
    System.out.println(System.getenv("PATH"));
    System.out.println(System.getenv("JAVA_WEB_NO_SUCH_VARIABLE"));
    System.out.println(System.getProperty("sun.java.command"));
  }
}
