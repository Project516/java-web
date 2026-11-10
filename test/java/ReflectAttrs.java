// javac: -g -parameters
import java.io.IOException;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

public class ReflectAttrs {
  @Retention(RetentionPolicy.RUNTIME)
  @Target({ ElementType.METHOD, ElementType.FIELD, ElementType.PARAMETER })
  @interface Tag {
    String value() default "none";
    int level() default 3;
  }

  @Retention(RetentionPolicy.RUNTIME)
  @Target(ElementType.TYPE_USE)
  @interface Use { }

  static class Box<T extends Comparable<T>> {
    @Tag("field") public Map<String, List<T>> items;
    public @Use String used;
    public int plain;

    @Tag(level = 7) public <U extends T> List<U> pick(@Tag("p") Map<String, U> from, int count, T[] more) throws IOException, IllegalStateException {
      return null;
    }

    public @Use String twice(@Use String s) { return s + s; }

    @Deprecated
    public void old() { }
  }

  static String describe(Method m) {
    StringBuilder sb = new StringBuilder(m.getName());
    sb.append(" ret=").append(m.getGenericReturnType());
    sb.append(" params=").append(Arrays.toString(m.getGenericParameterTypes()));
    sb.append(" throws=").append(Arrays.toString(m.getExceptionTypes()));
    sb.append(" ann=").append(Arrays.toString(m.getAnnotations()));
    for (Parameter p : m.getParameters()) {
      sb.append(" [").append(p.getName()).append(' ').append(Arrays.toString(p.getAnnotations())).append(']');
    }
    sb.append(" typeUse=").append(m.getAnnotatedReturnType().getAnnotations().length);
    return sb.toString();
  }

  static int length(String text) {
    String local = text;
    return local.length();
  }

  public static void main(String[] args) throws Exception {
    Method[] ms = Box.class.getDeclaredMethods();
    Arrays.sort(ms, Comparator.comparing(Method::getName));
    for (Method m : ms) System.out.println(describe(m));
    Field[] fs = Box.class.getDeclaredFields();
    Arrays.sort(fs, Comparator.comparing(Field::getName));
    for (Field f : fs) {
      System.out.println(f.getName() + " " + f.getGenericType() + " " + Arrays.toString(f.getAnnotations()) + " " + f.getAnnotatedType().getAnnotations().length);
    }
    System.out.println(Tag.class.getDeclaredMethod("value").getDefaultValue());
    try {
      length(null);
    } catch (NullPointerException e) {
      System.out.println(e.getMessage());
    }
    try {
      String a = args.length > 5 ? "x" : null;
      System.out.println(a.length());
    } catch (NullPointerException e) {
      System.out.println(e.getMessage());
    }
  }
}
