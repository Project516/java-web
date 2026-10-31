import java.lang.invoke.MethodHandles;
import java.lang.reflect.Method;

// Caller-sensitive methods called through reflection, which goes through
// their caller-sensitive adapters.
public class ReflectCallerSensitive {
  public static String hello(String s) { return "hello " + s; }

  public static void main(String[] args) throws Exception {
    Method hello = ReflectCallerSensitive.class.getMethod("hello", String.class);
    Method invoke = Method.class.getMethod("invoke", Object.class, Object[].class);
    System.out.println(invoke.invoke(hello, null, new Object[] {"once"}));
    System.out.println(invoke.invoke(invoke, hello, new Object[] {null, new Object[] {"twice"}}));

    Method forName = Class.class.getMethod("forName", String.class);
    System.out.println(forName.invoke(null, "java.util.ArrayList"));
    try {
      forName.invoke(null, "no.such.Type");
    } catch (java.lang.reflect.InvocationTargetException e) {
      System.out.println("cause " + e.getCause());
    }

    Method lookup = MethodHandles.class.getMethod("lookup");
    MethodHandles.Lookup l = (MethodHandles.Lookup) lookup.invoke(null);
    System.out.println("lookup class " + l.lookupClass().getName());

    // A reflective call inside a reflectively invoked stack walk that shows
    // reflection frames, as Mockito makes. The reflection implementation's own
    // frames differ between VMs, so they are left out.
    StackWalker walker = StackWalker.getInstance(StackWalker.Option.SHOW_REFLECT_FRAMES);
    Method walk = StackWalker.class.getMethod("walk", java.util.function.Function.class);
    Method getClassName = StackWalker.StackFrame.class.getMethod("getClassName");
    java.util.function.Function<java.util.stream.Stream<StackWalker.StackFrame>, java.util.List<String>> names = frames -> frames.map(f -> {
      try {
        return (String) getClassName.invoke(f);
      } catch (ReflectiveOperationException e) {
        throw new RuntimeException(e);
      }
    }).filter(n -> !n.startsWith("jdk.internal.reflect.")).toList();
    System.out.println(walk.invoke(walker, names));
  }
}
