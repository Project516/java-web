import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

public class ProcessLookup {
    static void start(String what, String... command) {
        try {
            Process p = new ProcessBuilder(command).start();
            System.out.println(what + " exit " + p.waitFor());
        } catch (IOException e) {
            // HotSpot's launch helper words the reason differently from a direct fork
            var m = java.util.regex.Pattern.compile("error[=:] ?(\\d+)").matcher(e.getCause().getMessage());
            System.out.println(what + " errno " + (m.find() ? m.group(1) : e.getCause().getMessage()));
        } catch (InterruptedException e) {
            throw new RuntimeException(e);
        }
    }

    public static void main(String[] args) throws Exception {
        File dir = Files.createTempDirectory("lookup").toFile();
        try {
            start("empty", "");
            start("missing", "no-such-program-xyz");
            start("missing path", dir + "/no-such-program");
            start("directory", dir.getPath());
            File script = new File(dir, "plain");
            Files.writeString(script.toPath(), "#!/bin/true\n");
            start("not executable", script.getPath());
            script.setExecutable(true);
            start("script", script.getPath());
            start("on PATH", "true");
        } finally {
            for (File f : dir.listFiles()) f.delete();
            dir.delete();
        }
    }
}
