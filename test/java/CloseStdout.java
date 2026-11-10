import java.io.File;
import java.io.IOException;

// A child that closes System.out ends its stdout at once: the parent reads it to the end before
// stderr, while the child writes more to stderr than a pipe holds.
public class CloseStdout {
    public static void main(String[] args) throws Exception {
        if (args.length > 0) {
            System.out.print("before close");
            System.out.close();
            byte[] line = new byte[1023];
            java.util.Arrays.fill(line, (byte) 'e');
            for (int i = 0; i < 1024; i++) {
                System.err.write(line);
                System.err.write('\n');
            }
            System.err.flush();
            try {
                new java.io.FileOutputStream(java.io.FileDescriptor.out).write('x');
                System.out.println("write after close worked");
            } catch (IOException e) {
                System.err.println("write after close: " + e.getMessage());
            }
            return;
        }
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        Process p = new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"), "CloseStdout", "child").start();
        String out = new String(p.getInputStream().readAllBytes());
        byte[] err = p.getErrorStream().readAllBytes();
        System.out.println("stdout: " + out);
        System.out.println("stderr bytes: " + err.length);
        String text = new String(err);
        System.out.println(text.substring(text.lastIndexOf('\n', text.length() - 2) + 1).trim());
        System.out.println("exit: " + p.waitFor());
    }
}
