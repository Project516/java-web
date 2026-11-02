public class InterfaceInitialization {
  static String mark(String name) {
    System.out.println(name);
    return name;
  }

  interface Root {
    String VALUE = mark("root");
    default void root() {}
  }
  interface Middle extends Root {}
  interface Left extends Middle {
    String VALUE = mark("left");
    default void left() {}
  }
  interface Right extends Root {
    String VALUE = mark("right");
    default void right() {}
  }
  static class Impl implements Left, Right {
    static String VALUE = mark("class");
  }

  interface Parent {
    String VALUE = mark("parent");
    default void parent() {}
  }
  interface Child extends Parent {
    String VALUE = mark("child");
  }

  public static void main(String[] args) {
    System.out.println(Child.VALUE);
    System.out.println(Impl.VALUE);
  }
}
