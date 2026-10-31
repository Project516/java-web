// javac: --enable-preview --release 25
// java: --enable-preview
// Primitive types in patterns (preview): the switch selector can be a primitive.
public class PrimitivePatterns {
  static int boxed(int i) {
    switch (i) {
      case Integer ii: return ii;
    }
  }

  static String narrow(int i) {
    return switch (i) {
      case byte b -> "byte " + b;
      case int j -> "int " + j;
    };
  }

  static String ofLong(long l) {
    return switch (l) {
      case 1L -> "one";
      case long x when x < 0 -> "negative " + x;
      case long x -> "long " + x;
    };
  }

  static String ofObject(Object o) {
    return switch (o) {
      case int i -> "int " + i;
      case double d -> "double " + d;
      default -> "other " + o;
    };
  }

  public static void main(String[] args) {
    System.out.println(boxed(42));
    System.out.println(narrow(100) + ", " + narrow(1000));
    System.out.println(ofLong(1) + ", " + ofLong(-5) + ", " + ofLong(7));
    System.out.println(ofObject(3) + ", " + ofObject(2.5) + ", " + ofObject("s"));
  }
}
