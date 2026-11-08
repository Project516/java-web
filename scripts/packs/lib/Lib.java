package lib;

// A library the packed program and compile take from a jar.
public final class Lib {
  public interface Named {
    String name();

    default String label() {
      return "<" + name() + ">";
    }
  }

  public static String greet(String who) {
    return "hello " + who + " ";
  }
}
