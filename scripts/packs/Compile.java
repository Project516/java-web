import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;

// Compile CLASSPATH PROCESSORPATH OUTDIR SOURCE...: a javax.tools compile with
// a jar classpath and an annotation processor, for javac.pack.
public class Compile {
  public static void main(String[] args) throws Exception {
    JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
    StandardJavaFileManager fm = javac.getStandardFileManager(null, Locale.ROOT, null);
    fm.setLocationFromPaths(StandardLocation.CLASS_OUTPUT, List.of(Path.of(args[2])));
    fm.setLocationFromPaths(StandardLocation.SOURCE_OUTPUT, List.of(Path.of(args[2])));
    List<String> options = new ArrayList<>(List.of("-classpath", args[0], "-processorpath", args[1], "-g", "-XDstringConcat=inline"));
    List<Path> sources = Arrays.stream(args, 3, args.length).map(Path::of).toList();
    List<String> diags = new ArrayList<>();
    boolean ok = javac.getTask(null, fm, d -> diags.add(d.toString()), options, null, fm.getJavaFileObjectsFromPaths(sources)).call();
    if (!ok) throw new IllegalStateException(String.join("\n", diags));
  }
}
