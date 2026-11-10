import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.util.Arrays;

// A child that closes System.out (or System.err) ends that stream at once: the parent reads it to
// the end first, while the child writes more to the other stream than a pipe holds.
public class CloseStdout {
    public static void main(String[] args) throws Exception {
        if (args.length > 0) {
            boolean out = args[0].equals("out");
            PrintStream closing = out ? System.out : System.err, other = out ? System.err : System.out;
            closing.print("before close");
            closing.close();
            byte[] line = new byte[1023];
            Arrays.fill(line, (byte) 'e');
            for (int i = 0; i < 1024; i++) {
                other.write(line);
                other.write('\n');
            }
            other.flush();
            try {
                new FileOutputStream(out ? FileDescriptor.out : FileDescriptor.err).write('x');
                other.println("write after close worked");
            } catch (IOException e) {
                other.println("write after close: " + e.getMessage());
            }
            return;
        }
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        for (String which : new String[] {"out", "err"}) {
            Process p = new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"), "CloseStdout", which).start();
            InputStream closed = which.equals("out") ? p.getInputStream() : p.getErrorStream();
            InputStream other = which.equals("out") ? p.getErrorStream() : p.getInputStream();
            String first = new String(closed.readAllBytes());
            byte[] rest = other.readAllBytes();
            System.out.println(which + " closed: " + first);
            System.out.println("other bytes: " + rest.length);
            String text = new String(rest);
            System.out.println(text.substring(text.lastIndexOf('\n', text.length() - 2) + 1).trim());
            System.out.println("exit: " + p.waitFor());
        }
    }
}
