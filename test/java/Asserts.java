// java: -ea -da:Asserts$Off -ea:java.util...
public class Asserts {
  static class Off {
    static String check() {
      try {
        assert false;
        return "off";
      } catch (AssertionError e) {
        return "on";
      }
    }
  }

  public static void main(String[] args) {
    try {
      assert false : "boom";
      System.out.println("main off");
    } catch (AssertionError e) {
      System.out.println("main on: " + e.getMessage());
    }
    System.out.println("Off " + Off.check());
    for (Class<?> c : new Class<?>[] {Asserts.class, Off.class, String.class, java.util.ArrayList.class, java.util.concurrent.ConcurrentHashMap.class}) {
      System.out.println(c.getName() + " " + c.desiredAssertionStatus());
    }
  }
}
