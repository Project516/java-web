import java.io.File;
import java.util.TreeMap;

// A child environment that has a variable named JAVA_WEB_ENV reaches the child intact.
public class ChildEnvChannel {
    public static void main(String[] args) throws Exception {
        if (args.length > 0) {
            System.out.println(System.getenv("JAVA_WEB_ENV"));
            System.out.println(new TreeMap<>(System.getenv()));
            return;
        }
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        String cp = System.getProperty("java.class.path");
        Process p = Runtime.getRuntime().exec(
            new String[] {java, "-cp", cp, "ChildEnvChannel", "child"},
            new String[] {"JAVA_WEB_ENV=payload", "A=b"});
        System.out.print(new String(p.getInputStream().readAllBytes()));
        System.out.println(p.waitFor());
    }
}
