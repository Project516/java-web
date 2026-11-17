import java.lang.ref.WeakReference;
import java.lang.reflect.Array;
import java.util.function.Supplier;

// A class loader that nothing refers to any more, with the classes it defined,
// is collected, after its classes ran static initializers, lambdas, string
// concatenation, reflection and an exception.
public class ClassUnload {
  public static class Probe {
    static final Object marker = new Object();

    public Probe() {}

    public static String hello(int n) {
      return "hello " + n;
    }

    public static Supplier<String> supplier() {
      return () -> "lambda";
    }

    public static void fail() {
      throw new IllegalStateException("probe");
    }
  }

  static class Loader extends ClassLoader {
    Loader() {
      super(ClassUnload.class.getClassLoader());
    }

    @Override
    protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
      if (!name.equals("ClassUnload$Probe")) return super.loadClass(name, resolve);
      synchronized (getClassLoadingLock(name)) {
        Class<?> c = findLoadedClass(name);
        if (c == null) {
          try (var in = getParent().getResourceAsStream(name.replace('.', '/') + ".class")) {
            byte[] b = in.readAllBytes();
            c = defineClass(name, b, 0, b.length);
          } catch (java.io.IOException e) {
            throw new ClassNotFoundException(name, e);
          }
        }
        return c;
      }
    }
  }

  static void use(WeakReference<?>[] out) throws Exception {
    Loader loader = new Loader();
    Class<?> c = Class.forName("ClassUnload$Probe", true, loader);
    Object o = c.getDeclaredConstructor().newInstance();
    Object array = Array.newInstance(c, 3);
    System.out.println(c.getMethod("hello", int.class).invoke(null, 7));
    System.out.println(((Supplier<?>) c.getMethod("supplier").invoke(null)).get());
    try {
      c.getMethod("fail").invoke(null);
    } catch (java.lang.reflect.InvocationTargetException e) {
      System.out.println(e.getCause().getMessage());
    }
    System.out.println(o.getClass().getClassLoader() == loader);
    out[0] = new WeakReference<>(loader);
    out[1] = new WeakReference<>(c);
    out[2] = new WeakReference<>(o);
    out[3] = new WeakReference<>(array);
  }

  public static void main(String[] args) throws Exception {
    WeakReference<?>[] refs = new WeakReference<?>[4];
    use(refs);
    for (int i = 0; i < 200; i++) {
      boolean cleared = true;
      for (WeakReference<?> r : refs) if (r.get() != null) cleared = false;
      if (cleared) break;
      System.gc();
      Thread.sleep(20);
    }
    System.out.println("loader " + (refs[0].get() == null));
    System.out.println("class " + (refs[1].get() == null));
    System.out.println("instance " + (refs[2].get() == null));
    System.out.println("array " + (refs[3].get() == null));
  }
}
