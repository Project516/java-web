import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.zip.CRC32;
import javax.annotation.processing.AbstractProcessor;
import javax.annotation.processing.RoundEnvironment;
import javax.annotation.processing.SupportedAnnotationTypes;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.Element;
import javax.lang.model.element.TypeElement;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticListener;
import javax.tools.FileObject;
import javax.tools.ForwardingJavaFileManager;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import com.sun.source.doctree.DocCommentTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.util.DocTrees;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePathScanner;

// Drives javac in-process the way an in-browser IDE does: in-memory sources and
// output, diagnostics through a listener.
public class Javac {
  static final Map<String, ByteArrayOutputStream> classes = new TreeMap<>();

  static JavaFileObject source(String name, String code) {
    return new SimpleJavaFileObject(URI.create("string:///" + name.replace('.', '/') + ".java"), JavaFileObject.Kind.SOURCE) {
      @Override
      public CharSequence getCharContent(boolean ignoreEncodingErrors) {
        return code;
      }
    };
  }

  static boolean compile(JavaCompiler javac, List<String> options, JavaFileObject... sources) {
    StandardJavaFileManager std = javac.getStandardFileManager(null, Locale.ROOT, null);
    JavaFileManager fm = new ForwardingJavaFileManager<>(std) {
      @Override
      public JavaFileObject getJavaFileForOutput(Location location, String className, JavaFileObject.Kind kind, FileObject sibling) {
        return new SimpleJavaFileObject(URI.create("mem:///" + className.replace('.', '/') + kind.extension), kind) {
          @Override
          public OutputStream openOutputStream() {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            classes.put(className, out);
            return out;
          }
        };
      }
    };
    DiagnosticListener<JavaFileObject> listener = d -> System.out.println(d.getKind() + " "
        + (d.getSource() == null ? "-" : d.getSource().getName()) + ":" + d.getLineNumber() + ":" + d.getColumnNumber()
        + " " + d.getCode() + ": " + d.getMessage(Locale.ROOT));
    boolean ok = javac.getTask(null, fm, listener, options, null, List.of(sources)).call();
    System.out.println("compiled: " + ok);
    return ok;
  }

  // Named with -processor, so javac loads it and makes itself read its module
  // through a reflective caller-sensitive call.
  @SupportedAnnotationTypes("*")
  public static class Names extends AbstractProcessor {
    @Override
    public SourceVersion getSupportedSourceVersion() {
      return SourceVersion.latestSupported();
    }

    @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment round) {
      for (Element e : round.getRootElements()) System.out.println("processor saw " + e.getKind() + " " + e);
      return false;
    }
  }

  public static void main(String[] args) throws Exception {
    JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
    System.out.println(javac.getClass().getName());
    List<String> options = new ArrayList<>(List.of("-classpath", "", "-encoding", "UTF-8", "-g", "-XDstringConcat=inline", "-proc:none"));

    compile(javac, options, source("demo.App", """
        package demo;

        import java.util.List;
        import java.util.function.Supplier;

        public class App {
          record Reading(String name, double value) {}

          sealed interface Command permits Drive, Stop {}
          record Drive(double speed) implements Command {}
          record Stop() implements Command {}

          static String describe(Command c) {
            return switch (c) {
              case Drive d when d.speed() > 0.5 -> "fast " + d.speed();
              case Drive d -> "slow " + d.speed();
              case Stop s -> "stop";
            };
          }

          public static String run() {
            List<Reading> rs = List.of(new Reading("gyro", 1.5), new Reading("encoder", 42));
            Supplier<String> s = () -> rs.stream().map(r -> r.name() + "=" + r.value()).toList().toString();
            return s.get() + " " + describe(new Drive(0.7)) + " " + describe(new Stop());
          }
        }
        """));
    for (var e : classes.entrySet()) {
      CRC32 crc = new CRC32();
      crc.update(e.getValue().toByteArray());
      System.out.printf("%s %d %08x%n", e.getKey(), e.getValue().size(), crc.getValue());
    }

    ClassLoader loader = new ClassLoader(Javac.class.getClassLoader()) {
      @Override
      protected Class<?> findClass(String name) throws ClassNotFoundException {
        ByteArrayOutputStream b = classes.get(name);
        if (b == null) throw new ClassNotFoundException(name);
        return defineClass(name, b.toByteArray(), 0, b.size());
      }
    };
    System.out.println(loader.loadClass("demo.App").getMethod("run").invoke(null));

    classes.clear();
    compile(javac, options, source("demo.Broken", """
        package demo;

        import java.util.*;

        public class Broken {
          @Deprecated(forRemoval = true) static void old() {}
          void f() {
            List raw = new ArrayList();
            raw.add("x");
            int x = "not an int";
            undefined();
          }
        }
        """), source("demo.Uses", """
        package demo;

        class Uses {
          void g() { Broken.old(); }
        }
        """));

    // Markdown doc comments: links become {@linkplain} through jdk.internal.md
    JavacTask task = (JavacTask) javac.getTask(null, null, null, List.of("-proc:none"), null, List.of(source("demo.Doc", """
        package demo;

        public class Doc {
          /// Uses [a list][java.util.List] and [String].
          void f() {}
        }
        """)));
    DocTrees trees = DocTrees.instance(task);
    for (var unit : task.parse()) {
      new TreePathScanner<Void, Void>() {
        @Override
        public Void visitMethod(MethodTree m, Void v) {
          DocCommentTree dc = trees.getDocCommentTree(getCurrentPath());
          System.out.println("doc " + m.getName() + ": " + dc + " " + dc.getFullBody().stream().map(t -> t.getKind().toString()).toList());
          return null;
        }
      }.scan(unit, null);
    }

    // a module's requires record the versions of the JDK modules it reads
    classes.clear();
    compile(javac, options, source("module-info", "module demo.mod { requires java.logging; exports demo; }"),
        source("demo.Api", "package demo; public class Api {}"));
    for (var e : classes.entrySet()) {
      CRC32 crc = new CRC32();
      crc.update(e.getValue().toByteArray());
      System.out.printf("%s %d %08x%n", e.getKey(), e.getValue().size(), crc.getValue());
    }

    classes.clear();
    compile(javac, List.of("-classpath", "", "-processorpath", System.getProperty("java.class.path"), "-processor", "Javac$Names"),
        source("demo.Tagged", """
        package demo;

        @Deprecated
        public class Tagged {
          interface Inner {}
        }
        """));
  }
}
