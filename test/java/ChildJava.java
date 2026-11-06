import java.io.File;
import java.util.Map;
import java.util.TreeMap;

public class ChildJava {
    static String run(String[] cmd, String[] env, boolean err) throws Exception {
        Process p = Runtime.getRuntime().exec(cmd, env);
        byte[] out = (err ? p.getErrorStream() : p.getInputStream()).readAllBytes();
        p.waitFor();
        return new String(out);
    }

    public static void main(String[] args) throws Exception {
        if (args.length > 0) {
            System.out.println(new TreeMap<>(System.getenv()));
            return;
        }
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        String cp = System.getProperty("java.class.path");
        String version = run(new String[] {java, "-version"}, null, true);
        String[] lines = version.split("\n");
        System.out.println(lines[0]);
        System.out.println(lines[1]);
        System.out.println(lines.length);
        // a name that starts with '=' reaches the child as an empty name
        String[] env = {"=ExitValue=3", "=C:=\\", "A=b"};
        System.out.print(run(new String[] {java, "-cp", cp, "ChildJava", "child"}, env, false));
    }
}
