import java.io.*;
import java.nio.charset.StandardCharsets;
import javax.tools.Tool;
import javax.tools.ToolProvider;

// Keeps one javac warm for the jtreg runner. Each request is one line of
// tab-separated javac arguments; the reply is "<exit code>\t<first output line>".
public class CompileServer {
    public static void main(String[] args) throws IOException {
        Tool javac = ToolProvider.getSystemJavaCompiler();
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        for (String line; (line = in.readLine()) != null; ) {
            ByteArrayOutputStream diag = new ByteArrayOutputStream();
            int rc;
            try {
                rc = javac.run(null, diag, diag, line.split("\t"));
            } catch (Throwable t) {
                rc = 99;
                diag.writeBytes(t.toString().getBytes(StandardCharsets.UTF_8));
            }
            String first = diag.toString(StandardCharsets.UTF_8).lines().filter(l -> !l.isBlank()).findFirst().orElse("");
            out.println(rc + "\t" + first.replace('\t', ' '));
        }
    }
}
