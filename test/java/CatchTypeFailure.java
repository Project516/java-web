// java: -XX:+UnlockDiagnosticVMOptions -XX:-BytecodeVerificationRemote -XX:-BytecodeVerificationLocal
// Disable eager verifier resolution to exercise failure during handler lookup.
import java.lang.reflect.InvocationTargetException;

public class CatchTypeFailure {
  public static class Missing extends RuntimeException {}
  public static class Caller {
    public static String run(Runnable task) {
      try {
        try {
          task.run();
          return "ok";
        } catch (Missing e) {
          return "missing";
        } catch (LinkageError e) {
          return "sibling";
        }
      } catch (LinkageError e) {
        return "outer " + e.getClass().getName();
      }
    }
  }
  static class Loader extends ClassLoader {
    protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
      if (name.equals("CatchTypeFailure$Missing")) throw new ClassNotFoundException(name);
      if (!name.equals("CatchTypeFailure$Caller")) return super.loadClass(name, resolve);
      Class<?> cls = findLoadedClass(name);
      if (cls == null) {
        try (var in = CatchTypeFailure.class.getResourceAsStream("/" + name + ".class")) {
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
  public static void main(String[] args) throws Exception {
    Class<?> caller = new Loader().loadClass("CatchTypeFailure$Caller");
    try {
      System.out.println(caller.getMethod("run", Runnable.class).invoke(null, (Runnable) () -> {
        throw new IllegalStateException("original");
      }));
    } catch (InvocationTargetException e) {
      System.out.println("escaped " + e.getCause().getClass().getName());
    }
  }
}
