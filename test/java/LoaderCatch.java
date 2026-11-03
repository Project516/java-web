import java.lang.reflect.InvocationTargetException;

public class LoaderCatch {
  public static class E extends RuntimeException {}
  public static class Caller {
    public static int calls;
    public static String run(Runnable task) {
      calls++;
      try {
        try {
          task.run();
          return "ok";
        } catch (E e) {
          return "caught";
        }
      } catch (LinkageError e) {
        return "linkage " + e.getClass().getName();
      }
    }
  }
  public static class Thrower implements Runnable {
    public void run() { throw new E(); }
  }
  static class Loader extends ClassLoader {
    final String own;
    final boolean split;
    Loader(String own) { this(own, true); }
    Loader(String own, boolean split) { this.own = own; this.split = split; }
    protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
      if (!split && name.equals("LoaderCatch$E")) return super.loadClass(name, resolve);
      if (!name.equals("LoaderCatch$E") && !name.equals("LoaderCatch$" + own)) return super.loadClass(name, resolve);
      Class<?> cls = findLoadedClass(name);
      if (cls == null) {
        try (var in = LoaderCatch.class.getResourceAsStream("/" + name + ".class")) {
          byte[] bytes = in.readAllBytes();
          cls = defineClass(name, bytes, 0, bytes.length);
        } catch (java.io.IOException e) {
          throw new ClassNotFoundException(name, e);
        }
      }
      if (resolve) resolveClass(cls);
      return cls;
    }
  }

  static void check(String label, int warmup) throws Exception {
    Class<?> caller = new Loader("Caller").loadClass("LoaderCatch$Caller");
    var method = caller.getMethod("run", Runnable.class);
    for (int i = 0; i < warmup; i++) method.invoke(null, (Runnable) () -> {});
    Runnable task = (Runnable) new Loader("Thrower").loadClass("LoaderCatch$Thrower").getConstructor().newInstance();
    try {
      System.out.println(label + " " + method.invoke(null, task));
    } catch (InvocationTargetException e) {
      System.out.println(label + " escaped " + (e.getCause().getClass().getClassLoader() == task.getClass().getClassLoader()));
    }
    System.out.println(label + " calls " + caller.getField("calls").get(null));
  }

  public static void main(String[] args) throws Exception {
    check("cold", 0);
    check("hot", 1000);
    Class<?> caller = new Loader("Caller", false).loadClass("LoaderCatch$Caller");
    System.out.println("parent " + caller.getMethod("run", Runnable.class).invoke(null, (Runnable) () -> { throw new E(); }));
    System.out.println("parent calls " + caller.getField("calls").get(null));
  }
}
