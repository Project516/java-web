public class BooleanStore {
  public static class Stores {
    public static int store(boolean[] values) {
      values[0] = true;
      return values[0] ? 1 : 0;
    }
  }

  static class Loader extends ClassLoader {
    Class<?> define(byte[] bytes) { return defineClass(null, bytes, 0, bytes.length); }
  }

  public static void main(String[] args) throws Exception {
    try {
      Stores.store(null);
    } catch (NullPointerException e) {
      System.out.println("null store: " + e.getClass().getName());
    }
    byte[] bytes;
    try (var in = BooleanStore.class.getResourceAsStream("BooleanStore$Stores.class")) {
      bytes = in.readAllBytes();
    }
    int changes = 0;
    for (int i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] == 4 && bytes[i + 1] == 0x54) {
        bytes[i] = 5;
        changes++;
      }
    }
    if (changes != 1) throw new AssertionError(changes);
    var method = new Loader().define(bytes).getMethod("store", boolean[].class);
    for (int i = 0; i < 1000; i++) {
      int value = (int) method.invoke(null, new boolean[1]);
      if (i == 0 || i == 999) System.out.println(value);
    }
  }
}
