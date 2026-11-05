import java.nio.file.Files;
import java.nio.file.Path;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.URI;
import java.util.Base64;
import java.util.List;
import javax.tools.JavaFileObject;
import javax.tools.FileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;

public class WarmJavac {
  public static String compile(String sourcePath, String missing, String outDir) throws Exception {
    String source = Files.readString(Path.of(sourcePath));
    Files.exists(Path.of(missing));
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    JavaFileObject input = new SimpleJavaFileObject(URI.create("string:///Result.java"), JavaFileObject.Kind.SOURCE) {
      @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return source; }
    };
    var compiler = ToolProvider.getSystemJavaCompiler();
    var files = compiler.getStandardFileManager(null, null, null);
    var output = new SimpleJavaFileObject(URI.create("memory:///Result.class"), JavaFileObject.Kind.CLASS) {
      @Override public OutputStream openOutputStream() { return bytes; }
    };
    var manager = new javax.tools.ForwardingJavaFileManager<>(files) {
      @Override public JavaFileObject getJavaFileForOutput(Location location, String className, JavaFileObject.Kind kind, FileObject sibling) { return output; }
    };
    boolean ok = compiler.getTask(null, manager, null, List.of("-g:none", "-classpath", ""), null, List.of(input)).call();
    if (!ok) return "compile failed";
    // output the warm-up itself writes must not make the next start miss
    Path out = Path.of(outDir);
    Files.createDirectories(out);
    Files.write(out.resolve("Result.class"), bytes.toByteArray());
    return Base64.getEncoder().encodeToString(bytes.toByteArray());
  }
}
